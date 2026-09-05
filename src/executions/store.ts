import { getDb } from "@/lib/db";
import type { StepRecord, WorkflowState } from "@/runtime/state";

import type { ToolCallRecord } from "@/runtime/state";

import type { ExecutionRecord, ExecutionStepRecord, ExecutionWorkspace, WorkflowLayout } from "./types";

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

export function createExecution(id: string, workflowId: string, input: Record<string, unknown>, startedAt = Date.now()): void {
  getDb()
    .prepare("INSERT INTO workflow_executions (id, workflow_id, status, started_at, input_json) VALUES (?,?,?,?,?)")
    .run(id, workflowId, "running", startedAt, json(input));
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
  getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = ?, finished_at = ?, error_code = ?, error_message = ?, step_count = ?,
              workspace_json = COALESCE(?, workspace_json)
        WHERE id = ?`,
    )
    .run(
      state.status,
      finishedAt,
      state.error?.code ?? null,
      state.error?.message ?? null,
      state.stepCount,
      workspace ? json(workspace) : null,
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
  };
}

export function listExecutions(opts: { workflowId?: string; limit?: number } = {}): ExecutionRecord[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = opts.workflowId
    ? getDb()
        .prepare("SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(opts.workflowId, limit)
    : getDb().prepare("SELECT * FROM workflow_executions ORDER BY started_at DESC LIMIT ?").all(limit);
  return (rows as unknown as ExecutionRow[]).map(toExecution);
}

export function getExecution(id: string): ExecutionRecord | null {
  const row = getDb().prepare("SELECT * FROM workflow_executions WHERE id = ?").get(id);
  return row ? toExecution(row as unknown as ExecutionRow) : null;
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
export function failInterruptedExecutions(at = Date.now()): number {
  const res = getDb()
    .prepare(
      `UPDATE workflow_executions
          SET status = 'failed', finished_at = ?, error_code = 'RUN_INTERRUPTED',
              error_message = 'the server stopped while this run was going'
        WHERE status = 'running'`,
    )
    .run(at);
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
