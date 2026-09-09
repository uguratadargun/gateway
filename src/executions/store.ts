import { DEFAULT_TEAM } from "@/lib/def-root";
import { getDb } from "@/lib/db";
import { costForUsage, tierOf } from "@/lib/pricing";
import type { StepRecord, WorkflowState } from "@/runtime/state";

import type { ToolCallRecord } from "@/runtime/state";

import type { ExecutionQuota } from "./quota";
import { summarizeExecutionQuota } from "./quota-summary";
import type { ExecutionClient, ExecutionRecord, ExecutionStepRecord, ExecutionWorkspace, StepUsage, WorkflowLayout } from "./types";

/**
 * Execution history in SQLite. Definitions stay in files; only what actually
 * happened is persisted here, which is what replay and the run list read.
 */

function json(v: unknown): string | null {
  if (v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/**
 * Settles runs left behind by a process that is gone, once per process.
 *
 * It runs here, on first use, rather than from the startup hook: importing this
 * module from instrumentation drags SQLite into bundles that cannot have it.
 * The flag hangs off globalThis because route handlers do not share a module
 * registry in dev.
 *
 * Only runs older than this process are swept. Without that cutoff the first
 * read after a run starts would settle the run that had just started — the
 * sweep cannot tell "abandoned" from "mine" by status alone.
 */
const g = globalThis as unknown as { __gateExecutionsReconciled?: boolean; __gateProcessStart?: number };
g.__gateProcessStart ??= Date.now();

function reconcileOnce(): void {
  if (g.__gateExecutionsReconciled) return;
  g.__gateExecutionsReconciled = true;
  try {
    failInterruptedExecutions(g.__gateProcessStart!);
  } catch {
    // A locked or missing database surfaces on the query that follows.
  }
}

/** Who a run belongs to and where its engine is. Absent means this server. */
export interface ExecutionOrigin {
  origin?: "server" | "local";
  /** Defaults to the engine, which is what everything but a session is. */
  driver?: "engine" | "session";
  userId?: string | null;
  teamId?: string;
  client?: ExecutionClient | null;
}

export function createExecution(
  id: string,
  workflowId: string,
  input: Record<string, unknown>,
  startedAt = Date.now(),
  resumedFrom: string | null = null,
  meta: ExecutionOrigin = {},
): void {
  // Sweep before this row exists, so it can never be swept.
  reconcileOnce();
  getDb()
    .prepare(
      `INSERT INTO workflow_executions
         (id, workflow_id, status, started_at, input_json, resumed_from,
          origin, user_id, team_id, client_host, client_repo, client_branch, last_seen_at, driver, client_session)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      workflowId,
      "running",
      startedAt,
      json(input),
      resumedFrom,
      meta.origin ?? "server",
      meta.userId ?? null,
      meta.teamId ?? DEFAULT_TEAM,
      meta.client?.host ?? null,
      meta.client?.repo ?? null,
      meta.client?.branch ?? null,
      startedAt,
      meta.driver ?? "engine",
      meta.client?.session ?? null,
    );
}

/**
 * Reopens a session-driven run that failed, so the session can try the node
 * it failed on again in the same worktree.
 *
 * The walk a session replays stops at the first failed step, so the failed
 * attempt is taken out of the history rather than marked: the node then reads
 * as never having run, and `gate next` hands it out at the same step index.
 * Every step before it stays — nothing that already ran is redone. Only the
 * trailing failed steps go; a failed step is always the last thing such a run
 * recorded, because failing is what ended it.
 *
 * Returns which nodes were dropped for retry, or null when the run is not one
 * this applies to: still running, never failed, or not a session's.
 */
export function reopenSessionExecution(id: string, at = Date.now()): { retried: string[] } | null {
  const db = getDb();
  const execution = getExecution(id);
  if (!execution || execution.driver !== "session" || execution.status !== "failed") return null;
  const failed = db
    .prepare(
      `SELECT step_index, node_id FROM workflow_execution_steps
        WHERE execution_id = ? AND status = 'failed'
          AND step_index > COALESCE((SELECT MAX(step_index) FROM workflow_execution_steps WHERE execution_id = ? AND status = 'completed'), -1)
        ORDER BY step_index ASC`,
    )
    .all(id, id) as Array<{ step_index: number; node_id: string }>;
  for (const step of failed) {
    db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id = ? AND step_index = ?").run(id, step.step_index);
  }
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM workflow_execution_steps WHERE execution_id = ?").get(id) as { n: number };
  db.prepare(
    `UPDATE workflow_executions
        SET status = 'running', finished_at = NULL, error_code = NULL, error_message = NULL,
            cancel_requested = 0, last_seen_at = ?, step_count = ?, quota_json = NULL, paused_at = NULL
      WHERE id = ?`,
  ).run(at, Number(remaining.n), id);
  return { retried: failed.map((s) => s.node_id) };
}

interface SessionUsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Costs a step the session did itself, from the gateway's own record.
 *
 * A node the session runs — or runs as its subagent — makes its model calls
 * through the person's own Claude Code, which the gateway files under that
 * session's id, not under the run. So such a step arrives with no usage, and
 * a run driven this way showed as nearly free. The plugin's session hook tells
 * the CLI the session's id, the run records it, and here the calls that
 * session made between the step's start and end are summed against the step.
 * An estimate, and marked as one: the session may have answered something
 * else in the same minutes. Better than a zero nobody believes.
 *
 * Only a step without usage of its own, and only once.
 */
export function attributeSessionUsage(executionId: string, stepIndex: number): StepUsage | null {
  const db = getDb();
  const execution = getExecution(executionId);
  const session = execution?.client?.session;
  if (!execution || !session) return null;
  const step = db
    .prepare("SELECT started_at, finished_at, model FROM workflow_execution_steps WHERE execution_id = ? AND step_index = ?")
    .get(executionId, stepIndex) as { started_at: number; finished_at: number; model: string | null } | undefined;
  if (!step || step.model) return null;
  const rows = db
    .prepare(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
              SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation_tokens
         FROM usage
        WHERE session_id = ? AND ts BETWEEN ? AND ? AND status < 400
        GROUP BY model`,
    )
    .all(session, step.started_at, step.finished_at) as unknown as SessionUsageRow[];
  if (!rows.length) return null;
  const usage: StepUsage = { model: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, source: "session" };
  let dominant = -1;
  for (const r of rows) {
    usage.inputTokens += r.input_tokens;
    usage.outputTokens += r.output_tokens;
    usage.cacheReadTokens += r.cache_read_tokens;
    usage.costUsd! += costForUsage(
      tierOf(r.model),
      { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheCreation: r.cache_creation_tokens },
      { model: r.model },
    );
    // One model names the step; the cost above is exact across all of them.
    if (r.output_tokens > dominant) {
      dominant = r.output_tokens;
      usage.model = r.model;
    }
  }
  db.prepare(
    `UPDATE workflow_execution_steps
        SET model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, usage_source = 'session'
      WHERE execution_id = ? AND step_index = ?`,
  ).run(usage.model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.costUsd, executionId, stepIndex);
  return usage;
}

/**
 * A local run reporting that it is still going.
 *
 * This is the only thing that separates a run in progress on a laptop from one
 * whose laptop went to sleep three hours ago: the server cannot see the
 * process, so silence is the signal.
 */
export function touchExecution(id: string, at = Date.now()): void {
  getDb().prepare("UPDATE workflow_executions SET last_seen_at = ? WHERE id = ?").run(at, id);
}

/**
 * Stop, for a run this process is not running.
 *
 * Nothing here can abort someone else's engine; the flag is picked up by the
 * client on its next report, which then aborts its own run — the same
 * RUN_CANCELLED path a server-side stop takes.
 */
export function requestExecutionCancel(id: string): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE workflow_executions SET cancel_requested = 1 WHERE id = ? AND status = 'running'")
        .run(id).changes,
    ) > 0
  );
}

export function isCancelRequested(id: string): boolean {
  const row = getDb().prepare("SELECT cancel_requested FROM workflow_executions WHERE id = ?").get(id);
  return !!row?.cancel_requested;
}

/** The diff a local run produced, uploaded when it finished. */
export function setExecutionDiff(id: string, diff: string): void {
  getDb().prepare("UPDATE workflow_executions SET diff_text = ? WHERE id = ?").run(diff, id);
}

export function getExecutionDiff(id: string): string | null {
  const row = getDb().prepare("SELECT diff_text FROM workflow_executions WHERE id = ?").get(id);
  return (row?.diff_text as string | undefined) ?? null;
}

export function recordStep(executionId: string, step: StepRecord): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_execution_steps
         (execution_id, step_index, node_id, visit, status, started_at, finished_at, input_json, output_json,
          error_code, error_message, model, input_tokens, output_tokens, cache_read_tokens, tool_calls_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(execution_id, step_index) DO NOTHING`,
    )
    .run(
      executionId,
      step.stepIndex,
      step.nodeId,
      step.visit,
      step.status,
      step.startedAt,
      step.finishedAt,
      json(step.input),
      json(step.output),
      step.error?.code ?? null,
      step.error?.message ?? null,
      step.usage?.model ?? null,
      step.usage?.inputTokens ?? 0,
      step.usage?.outputTokens ?? 0,
      step.usage?.cacheReadTokens ?? 0,
      step.toolCalls?.length ? json(step.toolCalls) : null,
    );
}

export function finishExecution(state: WorkflowState, workspace: ExecutionWorkspace | null = null, finishedAt = Date.now()): void {
  // Every step is already recorded, and the run's own last call left the
  // windows where they are, so this is the moment both halves are true.
  const quota = summarizeExecutionQuota(state.executionId, finishedAt);

  // A run that ends while it is waiting on the person — stopped, or its
  // session gone — closes that wait first, so the clock is right afterwards.
  getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = ?, finished_at = ?, error_code = ?, error_message = ?, step_count = ?,
              workspace_json = COALESCE(?, workspace_json), quota_json = ?,
              paused_ms = paused_ms + COALESCE(? - paused_at, 0), paused_at = NULL
        WHERE id = ?`,
    )
    .run(
      state.status,
      finishedAt,
      state.error?.code ?? null,
      state.error?.message ?? null,
      state.stepCount,
      workspace ? json(workspace) : null,
      json(quota),
      finishedAt,
      state.executionId,
    );
}

/**
 * The person's turn has begun: a session handed out a node marked
 * `asks: person`, and until it is answered the run is waiting, not working.
 * Idempotent — a second `gate next` on the same node changes nothing.
 */
export function pauseExecution(id: string, at = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE workflow_executions SET paused_at = ? WHERE id = ? AND status = 'running' AND paused_at IS NULL")
        .run(at, id).changes,
    ) > 0
  );
}

/** The person answered: the wait is added up and the clock runs again. */
export function resumeExecution(id: string, at = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare(
          `UPDATE workflow_executions
              SET paused_ms = paused_ms + MAX(0, ? - paused_at), paused_at = NULL
            WHERE id = ? AND paused_at IS NOT NULL`,
        )
        .run(at, id).changes,
    ) > 0
  );
}

/**
 * Stop, for a run a session drives.
 *
 * Such a run has no process to reach and nothing to unwind: between two CLI
 * calls it exists only as rows here, and the session may have been closed
 * hours ago. So it is settled on the spot — the same `RUN_CANCELLED` an engine
 * lands on — rather than flagged for a report that may never come. The flag
 * is set too, so a worker still mid-node aborts on its next report, and the
 * session finds the run stopped on its next `gate next`.
 */
export function stopSessionExecution(id: string, at = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare(
          `UPDATE workflow_executions
              SET status = 'failed', finished_at = ?, error_code = 'RUN_CANCELLED',
                  error_message = 'stopped from the dashboard', cancel_requested = 1,
                  paused_ms = paused_ms + COALESCE(? - paused_at, 0), paused_at = NULL
            WHERE id = ? AND status = 'running' AND driver = 'session'`,
        )
        .run(at, at, id).changes,
    ) > 0
  );
}

/** Recorded as soon as the worktree exists, so a running job shows its branch. */
export function setExecutionWorkspace(executionId: string, workspace: ExecutionWorkspace): void {
  getDb().prepare("UPDATE workflow_executions SET workspace_json = ? WHERE id = ?").run(json(workspace), executionId);
}

interface ExecutionRow {
  id: string;
  workflow_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  input_json: string | null;
  error_code: string | null;
  error_message: string | null;
  step_count: number;
  workspace_json: string | null;
  quota_json: string | null;
  resumed_from: string | null;
  origin: string | null;
  user_id: string | null;
  team_id: string | null;
  client_host: string | null;
  client_repo: string | null;
  client_branch: string | null;
  last_seen_at: number | null;
  cancel_requested: number | null;
  driver: string | null;
  paused_at: number | null;
  paused_ms: number | null;
  client_session: string | null;
}

function toExecution(r: ExecutionRow): ExecutionRecord {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    status: r.status as ExecutionRecord["status"],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    input: parse<Record<string, unknown>>(r.input_json, {}),
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
    stepCount: r.step_count,
    workspace: parse<ExecutionWorkspace | null>(r.workspace_json, null),
    quota: parse<ExecutionQuota | null>(r.quota_json, null),
    resumedFrom: r.resumed_from,
    origin: r.origin === "local" ? "local" : "server",
    userId: r.user_id,
    teamId: r.team_id ?? DEFAULT_TEAM,
    client:
      r.client_host || r.client_repo || r.client_branch || r.client_session
        ? { host: r.client_host, repo: r.client_repo, branch: r.client_branch, version: null, session: r.client_session ?? null }
        : null,
    lastSeenAt: r.last_seen_at,
    cancelRequested: !!r.cancel_requested,
    driver: r.driver === "session" ? "session" : "engine",
    pausedAt: r.paused_at ?? null,
    pausedMs: r.paused_ms ?? 0,
  };
}

export function listExecutions(
  opts: { workflowId?: string; limit?: number; teamId?: string; userId?: string } = {},
): ExecutionRecord[] {
  reconcileOnce();
  sweepAbandonedLocalRuns();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workflowId) {
    where.push("workflow_id = ?");
    params.push(opts.workflowId);
  }
  if (opts.teamId) {
    where.push("COALESCE(team_id, ?) = ?");
    params.push(DEFAULT_TEAM, opts.teamId);
  }
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  const sql = `SELECT * FROM workflow_executions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...params, limit);
  return (rows as unknown as ExecutionRow[]).map(toExecution);
}

export function getExecution(id: string): ExecutionRecord | null {
  reconcileOnce();
  sweepAbandonedLocalRuns();
  const row = getDb().prepare("SELECT * FROM workflow_executions WHERE id = ?").get(id);
  return row ? toExecution(row as unknown as ExecutionRow) : null;
}

/** Executions that resumed this one, most recent first. */
export function getResumedAs(id: string): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM workflow_executions WHERE resumed_from = ? ORDER BY started_at DESC")
    .all(id) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Every step across the whole chain a resumed run continues, oldest first —
 * this execution's own ancestors, walking `resumed_from` back to the run that
 * started fresh, followed by this execution's own steps.
 *
 * Also returns the fields that stay constant across a chain: which workflow
 * it is, what it was started with, and the worktree — reused as-is rather
 * than recreated, since resuming is the point of keeping one.
 */
export function getExecutionLineage(
  id: string,
): { steps: ExecutionStepRecord[]; workspace: ExecutionWorkspace | null; workflowId: string; input: Record<string, unknown> } | null {
  const chain: ExecutionRecord[] = [];
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break; // a cycle would only ever come from a corrupted row
    seen.add(cursor);
    const execution = getExecution(cursor);
    if (!execution) return null;
    chain.push(execution);
    cursor = execution.resumedFrom;
  }
  if (!chain.length) return null;
  chain.reverse(); // oldest ancestor first

  const steps = chain.flatMap((e) => getExecutionSteps(e.id));
  const root = chain[0];
  // The nearest ancestor's workspace record is freshest — same root/branch,
  // but its changedFiles/commit reflect the most recent work in it.
  const nearestWorkspace = [...chain].reverse().find((e) => e.workspace)?.workspace ?? null;
  return { steps, workspace: nearestWorkspace, workflowId: root.workflowId, input: root.input };
}

interface StepRow {
  execution_id: string;
  step_index: number;
  node_id: string;
  visit: number;
  status: string;
  started_at: number;
  finished_at: number;
  input_json: string | null;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  tool_calls_json: string | null;
  cost_usd: number | null;
  usage_source: string | null;
}

/** The exact path a run took, in order — the source for replay. */
export function getExecutionSteps(executionId: string): ExecutionStepRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_execution_steps WHERE execution_id = ? ORDER BY step_index ASC")
    .all(executionId) as unknown as StepRow[];
  return rows.map((r) => ({
    executionId: r.execution_id,
    stepIndex: r.step_index,
    nodeId: r.node_id,
    visit: r.visit,
    status: r.status as ExecutionStepRecord["status"],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    input: parse<unknown>(r.input_json, null),
    output: parse<unknown>(r.output_json, null),
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
    usage: r.model
      ? {
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          ...(r.cost_usd != null ? { costUsd: r.cost_usd } : {}),
          source: r.usage_source === "session" ? "session" : "reported",
        }
      : null,
    toolCalls: parse<ToolCallRecord[] | null>(r.tool_calls_json, null),
  }));
}

/**
 * Closes out runs left behind by a process that is gone.
 *
 * A run lives in the server process; nothing survives a restart. Rows left at
 * "running" would otherwise sit there for ever, streaming nothing and claiming
 * to be alive, so they are settled at boot for what they are: interrupted.
 */
export function failInterruptedExecutions(startedBefore: number, at = Date.now()): number {
  const res = getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = 'failed', finished_at = ?, error_code = 'RUN_INTERRUPTED',
              error_message = 'the server stopped while this run was going'
        WHERE status = 'running' AND started_at < ? AND COALESCE(origin, 'server') <> 'local'`,
    )
    .run(at, startedBefore);
  return Number(res.changes ?? 0);
}

/**
 * How long a local run may go quiet before it is written off.
 *
 * A run on someone's machine outlives this server: restarting gate must not
 * declare it dead, which is why the sweep above skips it. What can be said is
 * that a run reporting nothing for this long is not running any more — the
 * laptop slept, the process was killed, the network went. Generous, because a
 * single node can legitimately take half an hour without producing a step, and
 * the client heartbeats between steps anyway.
 */
const LOCAL_RUN_SILENCE_MS = 15 * 60_000;

/**
 * The same question for a run a session is driving, where silence is normal.
 *
 * Such a run reports when a node starts and when it ends, and a node is a
 * person and a model working — an implementer given a real change routinely
 * takes half an hour, and nobody should come back to find the run declared
 * dead underneath them. What this catches is the session that was closed and
 * never came back, which is worth catching eventually and not quickly. A run
 * waiting on the person is not swept at all: the wait is theirs, it can be
 * days, and Stop is there for a run they have given up on.
 */
const SESSION_RUN_SILENCE_MS = 6 * 60 * 60_000;

/**
 * The sweep, rate-limited to once a minute.
 *
 * Unlike the interrupted-run sweep this cannot be a once-per-process job: a
 * local run goes stale while the server is up and doing nothing in particular,
 * so it has to be re-checked as the run list is read.
 */
const sweepState = globalThis as unknown as { __gateLocalSweepAt?: number };

export function sweepAbandonedLocalRuns(now = Date.now()): void {
  if (sweepState.__gateLocalSweepAt && now - sweepState.__gateLocalSweepAt < 60_000) return;
  sweepState.__gateLocalSweepAt = now;
  try {
    failAbandonedLocalExecutions(now);
  } catch {
    // Reporting hygiene; never break a read over it.
  }
}

/** Settles local runs whose machine stopped reporting. */
export function failAbandonedLocalExecutions(
  at = Date.now(),
  silenceMs = LOCAL_RUN_SILENCE_MS,
  sessionSilenceMs = SESSION_RUN_SILENCE_MS,
): number {
  const res = getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = 'failed', finished_at = ?, error_code = 'RUN_ABANDONED',
              error_message = 'the machine running this stopped reporting'
        WHERE status = 'running' AND origin = 'local' AND paused_at IS NULL
          AND COALESCE(last_seen_at, started_at) < (CASE WHEN driver = 'session' THEN ? ELSE ? END)`,
    )
    .run(at, at - sessionSilenceMs, at - silenceMs);
  return Number(res.changes ?? 0);
}

export function deleteExecution(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id = ?").run(id);
  const res = db.prepare("DELETE FROM workflow_executions WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}

export function getLayout(workflowId: string): WorkflowLayout {
  const row = getDb().prepare("SELECT layout_json FROM workflow_layouts WHERE workflow_id = ?").get(workflowId);
  return row ? parse<WorkflowLayout>((row as { layout_json: string }).layout_json, {}) : {};
}

export function saveLayout(workflowId: string, layout: WorkflowLayout): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_layouts (workflow_id, layout_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(workflow_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
    )
    .run(workflowId, JSON.stringify(layout), Date.now());
}
