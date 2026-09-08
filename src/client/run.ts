import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

import { getAgent } from "@/agents/registry";
import { getSkill } from "@/skills/registry";
import type { WorkflowEvent } from "@/events/types";
import { runWorkflow } from "@/runtime/engine";
import { WorkflowError } from "@/runtime/errors";
import type { WorkflowState } from "@/runtime/state";
import { createRunWorkspace, readRunDiff, summarizeWorkspace, type RunWorkspace } from "@/runtime/workspace";
import { getWorkflow } from "@/workflows/registry";
import type { WorkflowDefinition } from "@/workflows/types";

import { CLI_VERSION, type GateClient } from "./api";
import { cacheScope } from "./cache";
import { HttpGateProvider } from "./http-provider";
import { RunReporter } from "./reporter";

/**
 * A workflow run, on this machine.
 *
 * The engine is the same one the server runs — same graph walk, same edge
 * conditions, same loop protection — pointed at three different things: the
 * definitions this machine pulled, a worktree of the repository the person is
 * actually working in, and the company gateway for every model call. What the
 * server keeps is what it always kept: the history, the live view, and the
 * metering.
 */

export interface LocalRunOptions {
  workflowId: string;
  input: Record<string, unknown>;
  /** Where the person ran the command; the repository is found from here. */
  cwd: string;
  team: string;
  /** Called for every engine event, for the terminal's live output. */
  onEvent?: (event: WorkflowEvent) => void;
  onNotice?: (message: string) => void;
  /** Connected-repo id → this machine's checkout of it. */
  repos?: Record<string, string>;
}

export interface LocalRunResult {
  executionId: string;
  state: WorkflowState;
  workspace: RunWorkspace | null;
}

/**
 * A path, as opposed to the id of a repository connected to the server.
 *
 * The server accepts both, because it holds the checkout either way. A client
 * holds neither: an id means nothing here until this machine says which of its
 * own clones it is.
 */
function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith(".") || value.includes("/");
}

/** The repository a run works in, resolved the way the server resolves it. */
export function resolveRepo(
  workflow: WorkflowDefinition,
  input: Record<string, unknown>,
  cwd: string,
  /** This machine's own answer to a connected repo's id — `gate repo <id> <path>`. */
  repos: Record<string, string> = {},
): string {
  const given = typeof input.repo === "string" ? input.repo.trim() : "";
  const pinned = workflow.workspace?.repo?.trim() ?? "";
  // An explicit input wins over a pin, exactly as it does on the server.
  const named = given || pinned;

  if (named && !isPathLike(named)) {
    // A workflow pinned to a repository the server has connected. On the
    // server that id resolves to a checkout it manages; here it can only mean
    // whichever clone of that project this person keeps, and only they know.
    const mapped = repos[named];
    if (mapped) return resolve(mapped.replace(/^~(?=\/|$)/, homedir()));
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in the connected repository "${named}", which this machine has no checkout for — ` +
        `run \`gate repo ${named} /path/to/your/clone\` once, or pass --input repo=/path/to/your/clone`,
    );
  }
  if (named) return resolve(named.replace(/^~(?=\/|$)/, homedir()));

  // Otherwise: the repository the person is standing in. This is the case that
  // only makes sense on a client — on the server there is no such thing as
  // "the directory you are working in".
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in a repository, and ${cwd} is not one — run it from a checkout, or pass --input repo=/path/to/repo`,
    );
  }
}

export async function runLocal(client: GateClient, opts: LocalRunOptions): Promise<LocalRunResult> {
  const scope = cacheScope(opts.team);
  const workflow = getWorkflow(opts.workflowId, scope);

  const input = { ...opts.input };
  let workspace: RunWorkspace | null = null;
  let repo: string | null = null;
  if (workflow.workspace) {
    repo = resolveRepo(workflow, input, opts.cwd, opts.repos ?? {});
    // Recorded on the run, so the dashboard can say which repository on which
    // machine a branch is sitting in.
    input.repo = repo;
  }

  const executionId = await client.startRun({
    workflowId: workflow.id,
    input,
    client: { host: hostname(), repo: repo ?? undefined, version: CLI_VERSION },
  });

  const controller = new AbortController();
  const reporter = new RunReporter(client, executionId, () => {
    opts.onNotice?.("stop requested from the dashboard");
    controller.abort();
  });

  // The worktree is created after the run is registered — it is named after the
  // execution — but before any node runs, so a workflow that cannot get its
  // workspace fails immediately rather than half-way through a plan.
  try {
    if (workflow.workspace) {
      workspace = createRunWorkspace({ ...workflow.workspace, repo: repo! }, executionId);
    }
  } catch (e) {
    const error = { code: e instanceof WorkflowError ? e.code : "WORKSPACE_ERROR", message: (e as Error).message };
    await client.finish(executionId, { status: "failed", error, stepCount: 0 }).catch(() => {});
    throw e;
  }

  reporter.start();
  const onInterrupt = () => {
    opts.onNotice?.("stopping…");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  let state: WorkflowState;
  try {
    state = await runWorkflow(workflow, {
      provider: new HttpGateProvider(client.gatewayUrl, client.key),
      input,
      executionId,
      workspace,
      loadAgent: (id) => getAgent(id, scope),
      loadSkill: (id) => getSkill(id, scope),
      // A node that runs as a spawned Claude Code talks to the same gateway
      // with the same key, so its calls are metered like every other call.
      claudeCode: { gatewayUrl: client.gatewayUrl, authToken: client.key },
      emit: (event) => {
        reporter.event(event);
        opts.onEvent?.(event);
      },
      onStep: (step) => reporter.step(step),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }

  await reporter.stop();

  // What the run left behind, sent up with the outcome: the worktree stays
  // here, so without this the dashboard could say a run finished and nothing
  // about what it did.
  const summary = workspace ? summarizeWorkspace(workspace) : null;
  let diff: string | null = null;
  if (workspace) {
    try {
      diff = readRunDiff(workspace.root, workspace.baseCommit).diff;
    } catch {
      // A worktree removed mid-run is already the run's own failure; not
      // reporting a diff for it is not a second one.
    }
  }

  await client
    .finish(executionId, {
      status: state.status === "completed" ? "completed" : "failed",
      error: state.error ?? null,
      stepCount: state.stepCount,
      workspace: summary,
      diff,
    })
    .catch((e) => opts.onNotice?.(`could not report the run's outcome: ${(e as Error).message}`));

  return { executionId, state, workspace };
}
