import { evaluateCondition } from "@/workflows/condition";
import type { WorkflowEdge, WorkflowNode } from "@/workflows/types";

import { WorkflowError } from "../errors";
import { conditionContext, type WorkflowState } from "../state";

/** All selectEdge and its evaluator read from a state — resuming reconstructs
 *  just this much rather than a full run in progress. */
export type ConditionState = Pick<WorkflowState, "outputs" | "input">;

/**
 * Edge selection — the only place the *next* node is decided, and it is pure
 * data: guarded edges in declaration order, then the single fallback edge.
 * A model never picks the next node.
 */
export function selectEdge(node: WorkflowNode, state: ConditionState): WorkflowEdge {
  const ctx = conditionContext(state);
  let fallback: WorkflowEdge | null = null;
  for (const edge of node.edges) {
    if (!edge.condition) {
      fallback = edge;
      continue;
    }
    let matched: boolean;
    try {
      matched = evaluateCondition(edge.condition, ctx);
    } catch (e) {
      throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${node.id}": ${(e as Error).message}`, {
        nodeId: node.id,
        when: edge.when,
      });
    }
    if (matched) return edge;
  }
  if (fallback) return fallback;
  throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${node.id}": no edge matched and no fallback edge is defined`, {
    nodeId: node.id,
  });
}
