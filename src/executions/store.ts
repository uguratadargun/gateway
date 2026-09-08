import { DEFAULT_TEAM } from "@/lib/def-root";
import { getDb } from "@/lib/db";
import type { StepRecord, WorkflowState } from "@/runtime/state";

import type { ToolCallRecord } from "@/runtime/state";

import type { ExecutionQuota } from "./quota";
import { summarizeExecutionQuota } from "./quota-summary";
import type { ExecutionClient, ExecutionRecord, ExecutionStepRecord, ExecutionWorkspace, WorkflowLayout } from "./types";

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
          origin, user_id, team_id, client_host, client_repo, client_branch, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    );
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

  getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = ?, finished_at = ?, error_code = ?, error_message = ?, step_count = ?,
              workspace_json = COALESCE(?, workspace_json), quota_json = ?
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
      state.executionId,
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
      r.client_host || r.client_repo || r.client_branch
        ? { host: r.client_host, repo: r.client_repo, branch: r.client_branch, version: null }
        : null,
    lastSeenAt: r.last_seen_at,
    cancelRequested: !!r.cancel_requested,
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
export function failAbandonedLocalExecutions(at = Date.now(), silenceMs = LOCAL_RUN_SILENCE_MS): number {
  const res = getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = 'failed', finished_at = ?, error_code = 'RUN_ABANDONED',
              error_message = 'the machine running this stopped reporting'
        WHERE status = 'running' AND origin = 'local' AND COALESCE(last_seen_at, started_at) < ?`,
    )
    .run(at, at - silenceMs);
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
