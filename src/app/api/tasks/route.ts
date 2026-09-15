import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { issuesForTask } from "@/memory/issues";
import { createTask, executionsForTask, getTask, listTasks, setTaskStatus, taskVisibleTo, type TaskStatus } from "@/orchestration/tasks";

export const runtime = "nodejs";

const STATUSES: TaskStatus[] = ["open", "done", "abandoned"];

/**
 * The tasks a team's tree is working on; `?id=` reads one with the runs that
 * served it and the objections those runs raised.
 */
export async function GET(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const task = taskVisibleTo(id, scope.teamId!);
    if (!task) return NextResponse.json({ error: "no such task" }, { status: 404 });
    return NextResponse.json({ task, executions: executionsForTask(task.id), issues: issuesForTask(task.id) });
  }
  const all = url.searchParams.get("all") === "1";
  return NextResponse.json({ tasks: listTasks(scope.teamId!, all ? { status: STATUSES } : {}) });
}

/** Opens a task. The team that owns it is the one asking. */
export async function POST(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const body = (await req.json().catch(() => null)) as { title?: unknown; summary?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "a task needs a title" }, { status: 400 });
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  return NextResponse.json(createTask({ teamId: scope.teamId!, title, summary }), { status: 201 });
}

/**
 * Closes or reopens one. A run finishing does not do this: a task is done
 * when somebody says the work is done, which is the whole reason it outlives
 * the runs.
 */
export async function PATCH(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const body = (await req.json().catch(() => null)) as { id?: unknown; status?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const status = body?.status as TaskStatus;
  if (!id || !STATUSES.includes(status)) return NextResponse.json({ error: "id and a known status are required" }, { status: 400 });
  if (!taskVisibleTo(id, scope.teamId!)) return NextResponse.json({ error: "no such task" }, { status: 404 });
  setTaskStatus(id, status);
  return NextResponse.json(getTask(id));
}
