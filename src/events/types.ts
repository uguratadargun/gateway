import type { WorkflowErrorCode } from "@/runtime/errors";

/** Everything the UI needs to animate a run, emitted as the engine steps. */

interface Base {
  executionId: string;
  at: number;
}

export interface NodeUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type WorkflowEvent =
  | (Base & { type: "workflow.started"; workflowId: string; entry: string })
  | (Base & { type: "node.started"; nodeId: string; stepIndex: number; visit: number })
  | (Base & { type: "node.output"; nodeId: string; stepIndex: number; output: unknown })
  | (Base & { type: "node.completed"; nodeId: string; stepIndex: number; durationMs: number; usage?: NodeUsage })
  | (Base & { type: "node.failed"; nodeId: string; stepIndex: number; code: WorkflowErrorCode; message: string })
  | (Base & { type: "tool.called"; nodeId: string; stepIndex: number; tool: string; ok: boolean; summary: string; durationMs: number })
  | (Base & { type: "edge.selected"; from: string; to: string; label?: string })
  /** A session handed a node to the person; the run waits, and its clock with it. */
  | (Base & { type: "run.paused"; nodeId: string })
  /** The person answered; the run is working again. */
  | (Base & { type: "run.resumed"; nodeId: string })
  | (Base & { type: "workflow.completed"; status: "completed" | "failed"; terminalNodeId: string })
  | (Base & { type: "workflow.failed"; code: WorkflowErrorCode; message: string; nodeId?: string });

export type WorkflowEventType = WorkflowEvent["type"];
export type EventSink = (event: WorkflowEvent) => void;
