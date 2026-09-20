import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { getAgent } from "@/agents/registry";
import { getSkill } from "@/skills/registry";
import { publishWorkflowEvent } from "@/events/bus";
import { GateModelProvider } from "@/providers/gate-provider";
import { runWorkflow, type RunWorkflowOptions } from "@/runtime/engine";
import { WorkflowError } from "@/runtime/errors";
import type { WorkflowState } from "@/runtime/state";
import {
  createRunWorkspace,
  releaseRunWorkspace,
  restoreRunWorkspace,
  summarizeWorkspace,
  type ResolvedWorkspaceSpec,
  type RunWorkspace,
} from "@/runtime/workspace";
import { getRepo, publicationTarget, type RepoRecord } from "@/repos/store";
import { isPathLike, prepareWorktree } from "@/repos/setup";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { DEFAULT_TEAM, teamScope, type DefinitionScope } from "@/lib/def-root";
import type { Principal } from "@/lib/apikeys";
import { INTERNAL_KEY_ID } from "@/lib/gate-auth";
import { withRunToken } from "@/lib/run-tokens";
import { getWorkflow } from "@/workflows/registry";
import { snapshotDefinitions } from "@/workflows/snapshot";
import type { WorkflowDefinition, WorkspaceSpec } from "@/workflows/types";

import { assertResumable, planResume } from "./resume";
import { LocalMemoryAccess } from "@/memory/access";
import { scheduleExtraction } from "@/memory/queue";

import { recordReportedSteps } from "./record";
import {
  createExecution,
  finishExecution,
  getExecution,
  getExecutionLineage,
  recordStep,
  setExecutionPublication,
  setExecutionRepo,
  setExecutionWorkspace,
} from "./store";
import type { ExecutionWorkspace } from "./types";

/**
 * Wires the engine to gate's persistence and event bus: the API layer starts a
 * run and returns immediately, while steps stream to the UI and land in SQLite
 * as they complete.
 */

const provider = new GateModelProvider();

/**
 * Runs in flight, so they can be stopped.
 *
 * A run lives in this process, not in the database, so cancellation has to
 * reach the same process that started it. The entry is removed when the run
 * settles, which also means "is this id cancellable" and "is it still going"
 * are the same question.
 *
 * It hangs off globalThis because route handlers do not share a module
 * registry in dev: the start and the cancel arrive through different routes,
 * and a per-module Map would leave the cancel looking at an empty one.
 */
const g = globalThis as unknown as { __gateRunsInFlight?: Map<string, AbortController> };
const inFlight = (g.__gateRunsInFlight ??= new Map<string, AbortController>());

/** Stops a running execution. False when there is nothing here to stop. */
export function cancelExecution(executionId: string): boolean {
  const controller = inFlight.get(executionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunning(executionId: string): boolean {
  return inFlight.has(executionId);
}

export interface StartExecutionResult {
  executionId: string;
  /** Resolves when the run finishes; the HTTP layer need not await it. */
  done: Promise<WorkflowState>;
}

/**
 * Which repository a run works in. The workflow may pin one; otherwise it is
 * the `repo` run input, so a single pipeline serves whatever project it is
 * pointed at. An explicit input wins over the pin.
 *
 * The value may be a path, as it always could, or the id of a connected repo —
 * which is the same answer with the checkout, the base ref and the per-worktree
 * preparation already attached to it. A path is anything that looks like one;
 * everything else is looked up, and an id that is not registered says so rather
 * than being handed to git as a directory name.
 */
function resolveWorkspace(
  spec: WorkspaceSpec,
  input: Record<string, unknown>,
): { spec: ResolvedWorkspaceSpec; repo: RepoRecord | null } {
  const given = typeof input.repo === "string" ? input.repo.trim() : "";
  const value = given || spec.repo?.trim() || "";
  // A run may be pinned to one commit by the caller, the same way it may be
  // pointed at one repository. `gate ask` is why: an answer about code is
  // about a fixed commit or it is about a moving branch, and a moving branch
  // is not a source. Unset — which is every ordinary run — leaves the
  // workflow's own base, then the repository's, then HEAD.
  const pinned = typeof input.baseRef === "string" ? input.baseRef.trim() : "";
  if (!value) {
    throw new WorkflowError("WORKSPACE_ERROR", 'this workflow works in a repository; start it with a "repo" run input');
  }
  if (isPathLike(value)) {
    return { spec: { ...spec, repo: value, baseRef: pinned || spec.baseRef }, repo: null };
  }

  const connected = getRepo(value);
  if (!connected) {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `no connected repository "${value}" — connect it first, or give an absolute path`,
    );
  }
  if (connected.status !== "ready") {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `repository "${value}" has not finished its setup (${connected.status}); run it from the Repos page first`,
    );
  }
  return {
    spec: { ...spec, repo: connected.root, baseRef: pinned || spec.baseRef || connected.baseRef || undefined },
    repo: connected,
  };
}

export function startExecution(
  workflowId: string,
  input: Record<string, unknown> = {},
  scope: DefinitionScope = teamScope(),
): StartExecutionResult {
  const workflow = getWorkflow(workflowId, scope);
  const missing = missingRunInputs(requiredRunInputs(workflow, (id) => getAgent(id, scope)), input);
  if (missing.length) {
    throw new WorkflowError(
      "RUN_INPUT_MISSING",
      `this workflow needs ${missing.length > 1 ? "run inputs" : "a run input"}: ${missing.join(", ")}`,
      { workflowId: workflow.id, missing },
    );
  }

  const executionId = randomUUID();
  createExecution(executionId, workflow.id, input, Date.now(), null, {
    teamId: scope.teamId,
    definitions: snapshotDefinitions(workflow.id, scope),
  });

  // The worktree is created before the first node runs: a workflow that cannot
  // get its workspace fails immediately rather than half-way through a plan.
  let workspace: RunWorkspace | null = null;
  let connected: RepoRecord | null = null;
  if (workflow.workspace) {
    try {
      const resolved = resolveWorkspace(workflow.workspace, input);
      connected = resolved.repo;
      // Recorded once the repo is resolved rather than at createExecution,
      // which runs before the workspace is known. A run in a repository gate
      // has no record of stays unnamed — the path it works in is not one.
      if (connected?.repoId) setExecutionRepo(executionId, connected.repoId);
      workspace = createRunWorkspace(resolved.spec, executionId);
      setExecutionWorkspace(executionId, { ...workspace, commit: null, changedFiles: [] });
    } catch (e) {
      const message = (e as Error).message;
      const code = e instanceof WorkflowError ? e.code : "WORKSPACE_ERROR";
      const state = failedState(executionId, workflow.id, input, code, message);
      finishExecution(state);
      publishWorkflowEvent({ type: "workflow.failed", executionId, at: Date.now(), code: state.error!.code as never, message });
      return { executionId, done: Promise.resolve(state) };
    }
  }

  return { executionId, done: launch(workflow, input, executionId, workspace, scope, undefined, connected) };
}

/**
 * Continues an execution that stopped — cancelled, hit a ceiling, or refused —
 * as a new one: same workflow, same input, the same worktree reused rather
 * than recreated, and progress reconstructed from the full history it
 * continues (its own steps plus every run it was itself resumed from).
 *
 * The node it resumes at falls out of that history alone (src/executions/
 * resume.ts) — nothing here branches on why the parent stopped. A parent that
 * hit maxVisits or maxWorkflowSteps lands back on the very node that tripped
 * the ceiling, with the cumulative count already there: it halts again at no
 * cost rather than buying the limit another five tries.
 */
export function resumeExecution(parentId: string): StartExecutionResult {
  const parent = getExecution(parentId);
  if (!parent) throw new WorkflowError("EXECUTION_NOT_RESUMABLE", `no execution "${parentId}"`);
  assertResumable(parent);

  const scope = teamScope(parent.teamId);
  const workflow = getWorkflow(parent.workflowId, scope);
  const lineage = getExecutionLineage(parentId);
  if (!lineage) throw new WorkflowError("EXECUTION_NOT_RESUMABLE", "could not read this run's history");
  const plan = planResume(workflow, lineage.steps, lineage.input);

  const { workspace, restored } = reuseWorkspace(lineage.workspace);
  // A worktree checked out again from its branch is as bare as a fresh one:
  // a connected repo's preparation runs on it again before the first node.
  let connected: RepoRecord | null = null;
  if (restored && workflow.workspace) {
    try {
      connected = resolveWorkspace(workflow.workspace, lineage.input).repo;
    } catch {
      // A repo disconnected since: the run goes on with what git brought back.
    }
  }

  const executionId = randomUUID();
  createExecution(executionId, parent.workflowId, lineage.input, Date.now(), parentId, {
    teamId: parent.teamId,
    userId: parent.userId,
    // Continuing a run does not change what the work was for, nor which
    // repository it was in.
    taskId: parent.taskId,
    repoId: parent.repoId,
    // The continuation's own snapshot, not the parent's: it walks the graph
    // that is on disk now — `getWorkflow` above read exactly that — and a run
    // must be held to the definitions it actually followed.
    definitions: snapshotDefinitions(parent.workflowId, scope),
  });
  if (workspace) setExecutionWorkspace(executionId, workspaceSummary(workspace)!);

  const resume: RunWorkflowOptions["resume"] = {
    outputs: plan.outputs,
    visitCounts: plan.visitCounts,
    stepCount: plan.stepCount,
    history: plan.history,
    startNodeId: plan.startNodeId,
  };
  return { executionId, done: launch(workflow, lineage.input, executionId, workspace, scope, resume, connected) };
}

/**
 * The worktree a resumed run reuses — checked out again from the run's branch
 * when it went with the run that ended. Refuses cleanly if it cannot be.
 */
function reuseWorkspace(workspace: ExecutionWorkspace | null): { workspace: RunWorkspace | null; restored: boolean } {
  if (!workspace) return { workspace: null, restored: false };
  const ws: RunWorkspace = {
    root: workspace.root,
    repo: workspace.repo,
    branch: workspace.branch,
    baseRef: workspace.baseRef,
    baseCommit: workspace.baseCommit,
  };
  try {
    return { workspace: ws, restored: restoreRunWorkspace(ws) };
  } catch (e) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      `the worktree this run used (${workspace.root}) is gone and could not be brought back from branch ${workspace.branch}: ${(e as Error).message}; Restart instead`,
    );
  }
}

/**
 * The run is over, whichever way: its worktree goes, its branch keeps the work
 * — and, if the repository publishes, the branch goes to the remote first,
 * while there is still a worktree to push from.
 */
function releaseWorkspace(workspace: RunWorkspace | null, executionId: string, connected?: RepoRecord | null): void {
  if (!workspace) return;
  const released = releaseRunWorkspace(workspace, executionId, {
    publish: publicationTarget(connected),
    onPublished: (outcome) =>
      setExecutionPublication(executionId, outcome.ok ? outcome.published : { error: outcome.note }),
  });
  if (released) console.log(`gate: ${released}`);
}

/** Runs the engine, tracks it as cancellable, and settles the execution either way. */
async function launch(
  workflow: WorkflowDefinition,
  input: Record<string, unknown>,
  executionId: string,
  workspace: RunWorkspace | null,
  /** Which team's agents this workflow's nodes name. */
  scope: DefinitionScope,
  resume?: RunWorkflowOptions["resume"],
  /** Connected repo, when the run named one: its worktree preparation runs first. */
  connected?: RepoRecord | null,
): Promise<WorkflowState> {
  const controller = new AbortController();
  inFlight.set(executionId, controller);

  // The run answers for itself at gate's own gateway. A node handed to a
  // headless Claude Code calls that gateway like any other client, and a gate
  // that has issued keys refuses a request without one whatever its source
  // address — so a node's child arrived as nobody and died on its first
  // request. The token is the run's own identity, read off its row: its person
  // where it has one, its team either way. `withRunToken` drops it however
  // this settles, including the crash path below.
  const row = getExecution(executionId);
  const principal: Principal = {
    keyId: INTERNAL_KEY_ID,
    userId: row?.userId ?? null,
    teamId: row?.teamId ?? scope.teamId ?? DEFAULT_TEAM,
    // The gateway and nothing else: a run's token has no business anywhere a
    // person's key goes, and the client API resolves keys by another route.
    scopes: ["gateway"],
  };

  return withRunToken(executionId, principal, async (runToken) => {
    try {
      // Linking dependencies and generating build output happen before the first
      // node, not as nodes: a worktree carries only what git tracks, and every
      // pipeline pointed at the same repo was otherwise repeating the same three
      // command nodes — one of which, got wrong, cost a whole run.
      if (connected && workspace) await prepareWorktree(connected, workspace.root);

      const state = await runWorkflow(workflow, {
        provider,
        input,
        executionId,
        workspace,
        loadAgent: (id) => getAgent(id, scope),
        loadSkill: (id) => getSkill(id, scope),
        // The credential a claude-code node's child authenticates with. No
        // gatewayUrl: the executor's own default is the gateway of this very
        // process, which is where a child on this machine belongs. A run on a
        // developer's machine comes through src/client/run.ts instead, with
        // that person's key and their server's URL, and that still wins.
        claudeCode: { authToken: runToken },
        // Memory answers as the run's team: its own tree, nothing else — and
        // about the repository this run is actually in, which the run knows and
        // the model does not have to be asked for.
        memory: new LocalMemoryAccess(scope.teamId ?? DEFAULT_TEAM, connected?.repoId ?? null),
        emit: publishWorkflowEvent,
        // Through the same door a reported step comes in by, so a node that
        // raises an objection has it written with the step here too — the
        // engine-side run is not a second, quieter path into the same tables.
        onStep: (step) => {
          const record = getExecution(executionId);
          if (record) {
            recordReportedSteps(record, [step]);
            return;
          }
          // The row a running execution was started from cannot normally be
          // gone. If it is, the step is still worth keeping, but an objection
          // in it has no team to be raised against and is dropped — which is
          // the kind of silence that makes a lost objection look like agreement.
          console.log(`gate: execution ${executionId} has no row — step ${step.nodeId} kept, its cross-team fields dropped`);
          recordStep(executionId, step);
        },
        signal: controller.signal,
        resume,
      });
      inFlight.delete(executionId);
      finishExecution(state, workspaceSummary(workspace));
      releaseWorkspace(workspace, executionId, connected);
      scheduleExtraction();
      return state;
    } catch (e) {
      // The engine records its own node failures; this covers preparing the
      // worktree and a crash in the engine itself, both of which must still
      // close out the execution row.
      inFlight.delete(executionId);
      const message = (e as Error).message;
      const code = e instanceof WorkflowError ? e.code : "WORKFLOW_ROUTING_ERROR";
      const state = failedState(executionId, workflow.id, input, code, message);
      finishExecution(state, workspaceSummary(workspace));
      releaseWorkspace(workspace, executionId, connected);
      publishWorkflowEvent({ type: "workflow.failed", executionId, at: Date.now(), code: code as never, message });
      scheduleExtraction();
      return state;
    }
  });
}

function workspaceSummary(workspace: RunWorkspace | null): ExecutionWorkspace | null {
  return workspace ? summarizeWorkspace(workspace) : null;
}

function failedState(
  executionId: string,
  workflowId: string,
  input: Record<string, unknown>,
  code: string,
  message: string,
): WorkflowState {
  return {
    executionId,
    workflowId,
    status: "failed",
    input,
    outputs: {},
    visitCounts: {},
    stepCount: 0,
    history: [],
    error: { code, message },
  };
}
