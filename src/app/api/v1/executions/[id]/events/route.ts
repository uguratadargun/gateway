import { NextResponse } from "next/server";

import { publishWorkflowEvent } from "@/events/bus";
import type { WorkflowEvent } from "@/events/types";
import { reportSchema } from "@/lib/client-api-schemas";
import { ownsExecution, requireClient } from "@/lib/tenancy";
import { recordReportedSteps } from "@/executions/record";
import {
  getExecution,
  isCancelRequested,
  pauseExecution,
  resumeExecution,
  setExecutionWorkspace,
  touchExecution,
} from "@/executions/store";
import type { StepRecord } from "@/runtime/state";

export const runtime = "nodejs";

/**
 * What a local run reports while it is going: steps to keep, events to replay.
 *
 * Steps land in the same table a server-side run writes to and events go onto
 * the same bus, so `/executions/<id>` and its SSE stream light up for a run on
 * someone's laptop exactly as they do for one in this process — the dashboard
 * never learns there is a difference.
 *
 * The reply carries the one thing that has to travel the other way: whether
 * someone pressed Stop. There is no channel from here into another machine's
 * engine, so the answer rides back on the report the client was making anyway.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });

  const parsed = reportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report", issues: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.workspace) {
    setExecutionWorkspace(id, { ...parsed.data.workspace, commit: null, changedFiles: [] });
  }
  // One transaction for the batch: a step that raises an objection against
  // another team is written with that objection or not at all. A throw here is
  // a 500 the client will retry with the same batch, which is safe — every
  // write in it is keyed so the retry finds its own work already done.
  const report = recordReportedSteps(execution, parsed.data.steps as StepRecord[]);

  for (const event of parsed.data.events) {
    // The person's turn is state, not just a line in the stream: the list
    // page and the clock read it from the row, long after the bus forgot.
    if (event.type === "run.paused") pauseExecution(id, event.at);
    if (event.type === "run.resumed") resumeExecution(id, event.at);
    // The URL owns the id: an event may only ever be about the run it was sent to.
    publishWorkflowEvent({ ...(event as object), executionId: id } as WorkflowEvent);
  }
  touchExecution(id);

  // `skipped` is the part of a step's output the server would not act on. It
  // rides back rather than becoming a 400 for the reason the protocol schemas
  // give: a refused report is re-sent whole and then dropped, so a model's
  // stray `conflicts: "none"` would cost the run every step it had left. The
  // client prints these; the run goes on.
  return NextResponse.json({
    cancelRequested: isCancelRequested(id),
    ...(report.skipped.length ? { skipped: report.skipped } : {}),
  });
}
