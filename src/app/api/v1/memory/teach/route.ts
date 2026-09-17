import { NextResponse } from "next/server";

import { teachSchema } from "@/lib/client-api-schemas";
import { loadSettings } from "@/lib/settings";
import { requireClient } from "@/lib/tenancy";
import { scheduleExtraction } from "@/memory/queue";
import { teachBranch } from "@/memory/teach";
import { taskVisibleTo } from "@/orchestration/tasks";

export const runtime = "nodejs";

/**
 * A finished branch, taught to the team's memory — `gate teach`, which
 * `/gate:teach` calls once the session has read the branch. It is kept as a
 * finished run and recorded by the same recorder a run is; the answer says
 * which run, so the person can watch its decisions land.
 */
export async function POST(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  const parsed = teachSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid teaching", issues: parsed.error.issues }, { status: 400 });
  }

  // A task the caller cannot see is not a task — the same refusal a run
  // starting under one gets, in the same words, because the two callers are
  // making the same claim about the same record.
  if (parsed.data.taskId && !taskVisibleTo(parsed.data.taskId, auth.teamId)) {
    return NextResponse.json({ error: "no such task", code: "TASK_NOT_FOUND" }, { status: 400 });
  }

  const outcome = teachBranch({ teamId: auth.teamId, userId: auth.userId }, parsed.data);
  if (!outcome.ok) {
    const error =
      outcome.code === "ALREADY_RECORDED"
        ? `run ${outcome.executionId.slice(0, 8)} (${outcome.workflowId}) already worked on this branch, and its record is on that run's page — teach it anyway with --force`
        : `the earlier teaching of this branch (${outcome.executionId.slice(0, 8)}) is being recorded right now — try again in a minute`;
    return NextResponse.json({ error, code: outcome.code, executionId: outcome.executionId }, { status: 409 });
  }

  scheduleExtraction();
  return NextResponse.json(
    { executionId: outcome.executionId, replaced: outcome.replaced, recording: loadSettings().memory.enabled },
    { status: outcome.replaced ? 200 : 201 },
  );
}
