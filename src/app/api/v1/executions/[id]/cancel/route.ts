import { NextResponse } from "next/server";

import { publishWorkflowEvent } from "@/events/bus";
import { ownsExecution, requireClient } from "@/lib/tenancy";
import { getExecution, requestExecutionCancel, stopSessionExecution } from "@/executions/store";
import { scheduleExtraction } from "@/memory/queue";

export const runtime = "nodejs";

/**
 * Stop, asked from a terminal instead of the dashboard.
 *
 * It is the same flag either way — the run is somewhere else, quite possibly on
 * another machine, and nothing here can reach into it. The process running it
 * picks the flag up on its next report and aborts itself.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  // The person who started it, like everything else on this API; a teammate's
  // run is stopped from the dashboard.
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });
  if (execution.status !== "running") {
    return NextResponse.json({ requested: false, reason: `run already ${execution.status}` });
  }
  // Same as the dashboard's Stop: a session-driven run is settled on the
  // spot, since there is no process for the flag to reach.
  if (execution.driver === "session") {
    const at = Date.now();
    const stopped = stopSessionExecution(id, at);
    if (stopped) {
      publishWorkflowEvent({ type: "workflow.failed", executionId: id, at, code: "RUN_CANCELLED", message: "stopped from the dashboard" });
      scheduleExtraction();
    }
    return NextResponse.json({ requested: stopped, stopped, ...(stopped ? {} : { reason: "this run has already settled" }) });
  }
  return NextResponse.json({ requested: requestExecutionCancel(id) });
}
