import type { ExecutionStepRecord } from "@/executions/types";
import { selectEdge } from "@/runtime/executors/condition";
import { WorkflowError } from "@/runtime/errors";
import { findNode, type WorkflowDefinition, type WorkflowNode } from "@/workflows/types";

/**
 * Where a run has got to, worked out by replaying what it has already done.
 *
 * The engine walks a workflow inside one process, holding its state in memory.
 * A run driven from a Claude Code session cannot: each `gate next` is a new
 * process, and the only durable record of the run is its steps. So the walk is
 * reconstructed instead — the graph is traversed from the entry node,
 * consuming recorded steps in the order they were produced, until it reaches a
 * node that has no step yet. That node is what runs next.
 *
 * This is the same traversal `runWorkflow` performs and it reuses the same edge
 * selection, so a run cannot take one path here and another there. What differs
 * is `parallel`: the engine starts branches together, and a session can only do
 * one thing at a time, so branches are walked in order. The graph, the
 * conditions and the join are untouched — only the concurrency is gone.
 *
 * `planResume` answers a narrower version of this question (where does a
 * stopped run pick up) and takes the shortcut of stepping over a parallel
 * node's branches, which is right for a resume — those branches already ran —
 * and wrong here.
 */

export type SessionPosition =
  | { kind: "node"; node: WorkflowNode; visit: number; outputs: Record<string, unknown>; stepIndex: number }
  | { kind: "done"; status: "completed" | "failed"; terminalNodeId: string; stepIndex: number }
  | { kind: "failed"; nodeId: string; error: { code: string; message: string } };

interface Replay {
  outputs: Record<string, unknown>;
  visitCounts: Record<string, number>;
  /** How many recorded steps have been consumed; also the next step's index. */
  cursor: number;
}

export function nextInSession(
  workflow: WorkflowDefinition,
  steps: ExecutionStepRecord[],
  input: Record<string, unknown>,
): SessionPosition {
  const replay: Replay = { outputs: {}, visitCounts: {}, cursor: 0 };
  const position = walk(workflow, steps, input, replay, workflow.entry, null);
  if (position) return position;
  // Falling out of the walk without a terminal means the graph let the run run
  // off its end, which the loader is supposed to make impossible.
  throw new WorkflowError("WORKFLOW_ROUTING_ERROR", "this run walked off the end of its workflow");
}

function walk(
  workflow: WorkflowDefinition,
  steps: ExecutionStepRecord[],
  input: Record<string, unknown>,
  replay: Replay,
  from: string,
  stopAt: string | null,
): SessionPosition | null {
  let currentId = from;
  for (;;) {
    if (currentId === stopAt) return null;
    const node = findNode(workflow, currentId);
    if (!node) {
      throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${currentId}" does not exist`, { nodeId: currentId });
    }
    if (node.type === "terminal") {
      return { kind: "done", status: node.status, terminalNodeId: node.id, stepIndex: replay.cursor };
    }

    const step = steps[replay.cursor];
    if (!step || step.nodeId !== node.id) {
      // The hole. Everything before it has been replayed, so the outputs and
      // visit counts handed back are exactly what this node would see.
      return {
        kind: "node",
        node,
        visit: (replay.visitCounts[node.id] ?? 0) + 1,
        outputs: { ...replay.outputs },
        stepIndex: replay.cursor,
      };
    }

    replay.cursor++;
    replay.visitCounts[node.id] = (replay.visitCounts[node.id] ?? 0) + 1;
    if (step.status === "failed") {
      return {
        kind: "failed",
        nodeId: node.id,
        error: step.error ?? { code: "MODEL_EXECUTION_ERROR", message: "this node failed" },
      };
    }
    // Control nodes route; they do not contribute state an agent can read.
    if (node.type !== "condition" && node.type !== "parallel") replay.outputs[node.id] = step.output;

    if (node.type === "parallel") {
      // One at a time, in the order the workflow lists them. A branch that is
      // not finished is where the run is, so the walk stops inside it.
      for (const branch of node.branches) {
        const inside = walk(workflow, steps, input, replay, branch, node.join);
        if (inside) return inside;
      }
      currentId = node.join;
      continue;
    }

    const state = { input, outputs: replay.outputs, visitCounts: replay.visitCounts };
    currentId = selectEdge(node, state).to;
  }
}
