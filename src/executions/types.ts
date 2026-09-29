/** What a run did in its git worktree, recorded when it finishes. */
import type { ToolCallRecord } from "@/runtime/state";

import type { ExecutionQuota } from "./quota";

export interface ExecutionWorkspace {
  root: string;
  repo: string;
  branch: string;
  baseRef: string;
  /** The commit the run branched from; absent on runs recorded before it was kept. */
  baseCommit?: string;
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
  /** The tokens and API-equivalent cost of the steps this run recorded. */
  quota: ExecutionQuota | null;
  /** The execution this one continued from, if it was resumed rather than started fresh. */
  resumedFrom: string | null;
  /**
   * Where it happened. "local" is a run on someone's own machine, reported
   * here — every run since 0.47.0. "server" is a run recorded by the server
   * itself: a merge made without gate, or a run the dashboard started before
   * 0.47.0.
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
   * What walked the graph. Every run since 0.47.0 is "session": it reports
   * when a node begins and ends, and a node can legitimately take an hour.
   * "engine" is a row from before, when gate's own engine ran the walk and
   * reported every few seconds.
   */
  driver: "engine" | "session";
  /**
   * Set while a session-driven run is waiting on the person — a node marked
   * `asks: person` has been handed out and not answered. The run is still
   * `running`; the dashboard shows it as paused, and its clock stands still.
   */
  pausedAt: number | null;
  /** How long the run has waited on the person so far, pauses now closed. */
  pausedMs: number;
  /**
   * The cross-team task this run serves. NULL on a run started without one,
   * which is most of them: this groups runs that belong together, it is not
   * how anything is found. A continued run inherits it from the run it
   * continued — `resumedFrom` is the continuation chain, and stays that.
   */
  taskId: string | null;
  /**
   * The repository the work happened in, as `host/owner/name` — the name
   * every clone of it agrees on. Null when nothing could say, which is what
   * every run recorded before identity existed carries. A relative path is
   * only meaningful next to this.
   */
  repoId: string | null;
  /**
   * The last verified publication of this run's branch — the remote reported
   * holding `publishedCommit` at `publishedRef` when this was checked, which
   * is not the same claim as "the run's branch has this commit": the branch
   * may have moved past it since (a checkpoint mid-run, then more work).
   * `publishError` holds the reason when a publication attempt failed; the
   * run's own result is unaffected either way.
   */
  publishedRef: string | null;
  publishedCommit: string | null;
  publishedAt: number | null;
  publishError: string | null;
}

/** The machine a local run happened on, as the client reported it. */
export interface ExecutionClient {
  host: string | null;
  repo: string | null;
  branch: string | null;
  version: string | null;
  /** The Claude Code session driving a session-driven run, when known. */
  session?: string | null;
}

/** Tokens and cost one step used, and where the figure came from. */
export interface StepUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Cost in USD when it was worked out exactly — a session's own calls are
   * summed per model, which the tokens above (one model) cannot restate.
   */
  costUsd?: number | null;
  /**
   * "reported" when the node's own executor measured it; "session" on a
   * step recorded before gate stopped serving models, when it was attributed
   * afterwards from the driving session's gateway traffic.
   */
  source?: "reported" | "session";
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
  usage: StepUsage | null;
  toolCalls: ToolCallRecord[] | null;
}

/** UI-only node positions, kept out of the logical workflow file. */
export type WorkflowLayout = Record<string, { x: number; y: number }>;
