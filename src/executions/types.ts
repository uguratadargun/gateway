/** What a run did in its git worktree, recorded when it finishes. */
import type { ToolCallRecord } from "@/runtime/state";

export interface ExecutionWorkspace {
  root: string;
  repo: string;
  branch: string;
  baseRef: string;
  commit: string | null;
  changedFiles: string[];
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt: number | null;
  input: Record<string, unknown>;
  error: { code: string; message: string } | null;
  stepCount: number;
  workspace: ExecutionWorkspace | null;
}

export interface ExecutionStepRecord {
  executionId: string;
  stepIndex: number;
  nodeId: string;
  visit: number;
  status: "completed" | "failed";
  startedAt: number;
  finishedAt: number;
  input: unknown;
  output: unknown;
  error: { code: string; message: string } | null;
  usage: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  toolCalls: ToolCallRecord[] | null;
}

/** UI-only node positions, kept out of the logical workflow file. */
export type WorkflowLayout = Record<string, { x: number; y: number }>;
