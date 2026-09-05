import { selectEdge } from "@/runtime/executors/condition";
import { WorkflowError } from "@/runtime/errors";
import type { ResumeSeed } from "@/runtime/state";
import { findNode, type WorkflowDefinition } from "@/workflows/types";

import type { ExecutionRecord, ExecutionStepRecord } from "./types";

/**
 * Working out where a stopped run left off — the read half of resuming one.
 *
 * The engine's own history says everything: a step that failed is retried
 * directly; a step that completed cleanly means the run stopped between
 * nodes, so the node it was headed for is re-derived by asking the same
 * routing the engine itself would use, from exactly what that step produced.
 * Nothing here is specific to why the run stopped — a cancelled run, one that
 * hit the loop ceiling, and one a transient model error interrupted all reduce
 * to the same two cases, and a run that hit the loop or step ceiling lands
 * back on the very node that tripped it: the reconstructed visit count is
 * already at the limit, so the resumed run halts again immediately, at no
 * cost, rather than quietly buying the ceiling another five tries.
 */

/**
 * Whether an execution can be resumed at all — before touching its history.
 *
 * A run that reached a terminal node (approved, or a deliberate `status:
 * failed` terminal) never records a step for that node, so its last step
 * always looks like ordinary progress; there is no shape in the step history
 * that says "this was the end on purpose". What does say that is the engine
 * itself: reaching a terminal never sets `state.error`, only a halt does — so
 * a finished run with no error is done, and one with an error stopped
 * somewhere still in progress, which is exactly what "Continue" is for.
 */
export function assertResumable(execution: Pick<ExecutionRecord, "status" | "error">): void {
  if (execution.status === "running") {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", "this run is still going; stop it first, or wait for it to finish");
  }
  if (!execution.error) {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", "this run already finished; there is nothing to continue");
  }
}

/** The run's progress and where it should pick back up. */
export type ResumePlan = ResumeSeed & { startNodeId: string };

/**
 * `steps` is the full lineage in chronological order — this execution's own
 * steps preceded by every ancestor it resumed from, oldest first.
 */
export function planResume(
  workflow: WorkflowDefinition,
  steps: ExecutionStepRecord[],
  input: Record<string, unknown>,
): ResumePlan {
  if (!steps.length) {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", "nothing ran in this execution yet; use Restart instead");
  }

  const visitCounts: Record<string, number> = {};
  const outputs: Record<string, unknown> = {};
  for (const step of steps) {
    visitCounts[step.nodeId] = (visitCounts[step.nodeId] ?? 0) + 1;
    if (step.status !== "completed") continue;
    const node = findNode(workflow, step.nodeId);
    // Matches the engine's own rule: condition and parallel nodes route: they
    // never contribute a value a later condition can read.
    if (node && node.type !== "condition" && node.type !== "parallel") outputs[step.nodeId] = step.output;
  }

  const last = steps[steps.length - 1];
  if (last.status === "failed" && !findNode(workflow, last.nodeId)) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      `node "${last.nodeId}" no longer exists in this workflow; it was edited since this run`,
    );
  }
  const startNodeId = last.status === "failed" ? last.nodeId : nextAfter(workflow, last, outputs, input);

  return { outputs, visitCounts, stepCount: steps.length, startNodeId, history: steps.map(stripExecutionId) };
}

/** What runs after a step that finished cleanly — the run stopped before it, not during it. */
function nextAfter(
  workflow: WorkflowDefinition,
  last: ExecutionStepRecord,
  outputs: Record<string, unknown>,
  input: Record<string, unknown>,
): string {
  const node = findNode(workflow, last.nodeId);
  if (!node) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      `node "${last.nodeId}" no longer exists in this workflow; it was edited since this run`,
    );
  }
  if (node.type === "terminal") {
    // Never actually reachable from real history (see assertResumable above) —
    // a terminal never gets its own step — but a defensive match for it all
    // the same, in case that ever changes.
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", "this run already finished; there is nothing to continue");
  }
  // Mirrors the engine: a parallel node's own step is control-flow only, and
  // the walk always goes straight to its join once it is recorded.
  if (node.type === "parallel") return node.join;

  const edge = selectEdge(node, { input, outputs });
  return edge.to;
}

function stripExecutionId(step: ExecutionStepRecord) {
  const { executionId: _executionId, error, usage, toolCalls, ...rest } = step;
  return {
    ...rest,
    error: error ?? undefined,
    usage: usage ?? undefined,
    toolCalls: toolCalls ?? undefined,
  };
}
