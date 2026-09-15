import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { teamFamily } from "@/lib/teams";

/**
 * The cross-team task: one piece of work that several teams have a hand in.
 *
 * A run belongs to one team and one repository, and it ends. The work does
 * not — desktop ships something, the server team reads it a week later and
 * finds it will not hold, and the thing both of those runs were about needs a
 * name that outlived them both. That name is this record.
 *
 * This is the whole of it for now: an id, an owner, a title, a status. The
 * plan's baselines, plan versions and per-team work items are built on this
 * id, not on a re-derivation of it, which is why it exists before any of them
 * do. Adding it later would mean re-deciding what an already-linked run meant.
 *
 * It is never required. Runs started without one — nearly all of them today —
 * behave exactly as they did, and nothing looks an objection up by task: the
 * paths and the feature do that, because the run that raised the objection may
 * well have been started by somebody who never opened a task at all. The task
 * is a label that groups; it is not a key that finds.
 */

export type TaskStatus = "open" | "done" | "abandoned";

/** A task may still be worked on. */
export const LIVE_TASK_STATUSES: TaskStatus[] = ["open"];

export interface ChangeTask {
  id: string;
  /** The team that owns the work — usually the parent of the teams doing it. */
  teamId: string;
  title: string;
  summary: string;
  status: TaskStatus;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDraft {
  teamId: string;
  title: string;
  summary?: string;
  createdBy?: string | null;
}

function rowToTask(r: any): ChangeTask {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    title: r.title as string,
    summary: (r.summary as string) ?? "",
    status: r.status as TaskStatus,
    createdBy: (r.created_by as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function createTask(draft: TaskDraft, now = Date.now()): ChangeTask {
  const task: ChangeTask = {
    id: `task_${randomUUID()}`,
    teamId: draft.teamId,
    title: draft.title,
    summary: draft.summary ?? "",
    status: "open",
    createdBy: draft.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO change_tasks (id, team_id, title, summary, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(task.id, task.teamId, task.title, task.summary, task.status, task.createdBy, task.createdAt, task.updatedAt);
  return task;
}

export function getTask(id: string): ChangeTask | null {
  const row = getDb().prepare("SELECT * FROM change_tasks WHERE id = ?").get(id);
  return row ? rowToTask(row) : null;
}

/**
 * The tasks a team may see: its own and its family's, on the same boundary as
 * memory. A task the parent opened is the whole point, so a child team looking
 * only at its own row would never find the work it was asked to do.
 */
export function listTasks(teamId: string, opts: { status?: TaskStatus[]; limit?: number } = {}): ChangeTask[] {
  const family = teamFamily(teamId);
  const statuses = opts.status ?? LIVE_TASK_STATUSES;
  const sql = `SELECT * FROM change_tasks
                WHERE team_id IN (${family.map(() => "?").join(",")})
                  AND status IN (${statuses.map(() => "?").join(",")})
                ORDER BY updated_at DESC LIMIT ?`;
  return (getDb()
    .prepare(sql)
    .all(...family, ...statuses, opts.limit ?? 100) as any[]).map(rowToTask);
}

/**
 * Whether the task is one this team may attach a run to. A task outside the
 * family is not refused with a reason that admits it exists — from here it
 * simply is not a task.
 */
export function taskVisibleTo(id: string, teamId: string): ChangeTask | null {
  const task = getTask(id);
  if (!task) return null;
  return teamFamily(teamId).includes(task.teamId) ? task : null;
}

/** Closes or reopens a task. A run finishing is not this; somebody says so. */
export function setTaskStatus(id: string, status: TaskStatus, now = Date.now()): boolean {
  const changes = getDb().prepare("UPDATE change_tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id).changes;
  return Number(changes) > 0;
}

/** The runs that said they were serving this task, newest first. */
export function executionsForTask(taskId: string, limit = 200): Array<{ id: string; teamId: string; status: string; startedAt: number }> {
  return (
    getDb()
      .prepare(
        `SELECT id, team_id, status, started_at FROM workflow_executions
          WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as any[]
  ).map((r) => ({ id: r.id as string, teamId: r.team_id as string, status: r.status as string, startedAt: r.started_at as number }));
}
