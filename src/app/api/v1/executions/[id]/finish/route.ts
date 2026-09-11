import { NextResponse } from "next/server";

import { finishRunSchema } from "@/lib/client-api-schemas";
import { ownsExecution, requireClient } from "@/lib/tenancy";
import { finishExecution, getExecution, setExecutionDiff } from "@/executions/store";
import { scheduleExtraction } from "@/memory/queue";
import type { WorkflowState } from "@/runtime/state";

export const runtime = "nodejs";

/**
 * A local run settling. The worktree it produced stays on the machine that
 * made it, so the diff comes with the report — otherwise the dashboard could
 * show that a run finished and nothing about what it did.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });
  if (execution.status !== "running") return NextResponse.json({ ok: true, alreadyFinished: true });

  const parsed = finishRunSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid finish report", issues: parsed.error.issues }, { status: 400 });
  }
  const { status, error, stepCount, workspace, diff } = parsed.data;

  const state: WorkflowState = {
    executionId: id,
    workflowId: execution.workflowId,
    status,
    input: execution.input,
    outputs: {},
    visitCounts: {},
    stepCount,
    history: [],
    error: error ? { code: error.code, message: error.message } : null,
  };

  finishExecution(state, workspace ?? null);
  if (diff) setExecutionDiff(id, diff);
  // The diff is in; the recorder may read the run now.
  scheduleExtraction();
  return NextResponse.json({ ok: true });
}
