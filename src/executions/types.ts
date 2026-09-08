/** What a run did in its git worktree, recorded when it finishes. */
import type { ToolCallRecord } from "@/runtime/state";

import type { ExecutionQuota } from "./quota";

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
  /** Where the account's rate-limit windows stood before and after the run. */
  quota: ExecutionQuota | null;
  /** The execution this one continued from, if it was resumed rather than started fresh. */
  resumedFrom: string | null;
  /**
   * Where the engine ran. "server" is a run started from the dashboard; "local"
   * is one the client CLI ran on someone's own machine and reported here.
   */
  origin: "server" | "local";
  /** Who ran it, when a key with an owner did. */
  userId: string | null;
  teamId: string;
  client: ExecutionClient | null;
  /** Last report from a local run; how a machine that went away is noticed. */
  lastSeenAt: number | null;
  /** Set when someone pressed Stop on a run this process does not own. */
  cancelRequested: boolean;
  /**
   * What is walking the graph. An engine-driven run reports every few seconds,
   * so silence means its machine went away; a session-driven one reports when
   * a node begins and ends, and a node can legitimately take an hour.
   */
  driver: "engine" | "session";
}

/** The machine a local run happened on, as the client reported it. */
export interface ExecutionClient {
  host: string | null;
  repo: string | null;
  branch: string | null;
  version: string | null;
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
