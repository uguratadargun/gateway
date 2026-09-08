import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { getAgent } from "@/agents/registry";
import { getSkill } from "@/skills/registry";
import { publishWorkflowEvent } from "@/events/bus";
import { GateModelProvider } from "@/providers/gate-provider";
import { runWorkflow, type RunWorkflowOptions } from "@/runtime/engine";
import { WorkflowError } from "@/runtime/errors";
import type { WorkflowState } from "@/runtime/state";
import { createRunWorkspace, summarizeWorkspace, type ResolvedWorkspaceSpec, type RunWorkspace } from "@/runtime/workspace";
import { getRepo, type RepoRecord } from "@/repos/store";
import { isPathLike, prepareWorktree } from "@/repos/setup";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { teamScope, type DefinitionScope } from "@/lib/def-root";
import { getWorkflow } from "@/workflows/registry";
import type { WorkflowDefinition, WorkspaceSpec } from "@/workflows/types";

import { assertResumable, planResume } from "./resume";
import { createExecution, finishExecution, getExecution, getExecutionLineage, recordStep, setExecutionWorkspace } from "./store";
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
  if (!value) {
    throw new WorkflowError("WORKSPACE_ERROR", 'this workflow works in a repository; start it with a "repo" run input');
  }
  if (isPathLike(value)) return { spec: { ...spec, repo: value }, repo: null };

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
    spec: { ...spec, repo: connected.root, baseRef: spec.baseRef ?? connected.baseRef ?? undefined },
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
  createExecution(executionId, workflow.id, input, Date.now(), null, { teamId: scope.teamId });

  // The worktree is created before the first node runs: a workflow that cannot
  // get its workspace fails immediately rather than half-way through a plan.
  let workspace: RunWorkspace | null = null;
  let connected: RepoRecord | null = null;
  if (workflow.workspace) {
    try {
      const resolved = resolveWorkspace(workflow.workspace, input);
      connected = resolved.repo;
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

  const workspace = reuseWorkspace(lineage.workspace);

  const executionId = randomUUID();
  createExecution(executionId, parent.workflowId, lineage.input, Date.now(), parentId, {
    teamId: parent.teamId,
    userId: parent.userId,
  });
  if (workspace) setExecutionWorkspace(executionId, workspaceSummary(workspace)!);

  const resume: RunWorkflowOptions["resume"] = {
    outputs: plan.outputs,
    visitCounts: plan.visitCounts,
    stepCount: plan.stepCount,
    history: plan.history,
    startNodeId: plan.startNodeId,
  };
  return { executionId, done: launch(workflow, lineage.input, executionId, workspace, scope, resume) };
}

/** The worktree a resumed run reuses. Refuses cleanly if it is no longer there. */
function reuseWorkspace(workspace: ExecutionWorkspace | null): RunWorkspace | null {
  if (!workspace) return null;
  if (!existsSync(workspace.root)) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      `the worktree this run used (${workspace.root}) no longer exists on disk; Restart instead`,
    );
  }
  return { root: workspace.root, repo: workspace.repo, branch: workspace.branch, baseRef: workspace.baseRef, baseCommit: workspace.baseCommit };
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
      emit: publishWorkflowEvent,
      onStep: (step) => recordStep(executionId, step),
      signal: controller.signal,
      resume,
    });
    inFlight.delete(executionId);
    finishExecution(state, workspaceSummary(workspace));
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
    publishWorkflowEvent({ type: "workflow.failed", executionId, at: Date.now(), code: code as never, message });
    return state;
  }
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
