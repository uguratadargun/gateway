import { NextResponse } from "next/server";

import { publishWorkflowEvent } from "@/events/bus";
import { getExecution, requestExecutionCancel, stopSessionExecution } from "@/executions/store";
import { scheduleExtraction } from "@/memory/queue";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Stops a run. Every run is driven from someone's own Claude Code session,
 * which between two CLI calls is rows and a marker on their disk — the
 * session may have been closed long ago — so it is settled here and now.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (execution.status !== "running") {
    return NextResponse.json({ cancelled: false, reason: `run already ${execution.status}` });
  }
  if (execution.driver === "session") {
    const at = Date.now();
    const stopped = stopSessionExecution(id, at);
    if (stopped) {
      publishWorkflowEvent({ type: "workflow.failed", executionId: id, at, code: "RUN_CANCELLED", message: "stopped from the dashboard" });
      scheduleExtraction();
    }
    return NextResponse.json({ cancelled: stopped, ...(stopped ? {} : { reason: "this run has already settled" }) });
  }
  // A run an older client drove headlessly sees the flag on its next report.
  const requested = requestExecutionCancel(id);
  return NextResponse.json({
    cancelled: requested,
    pending: requested,
    ...(requested ? {} : { reason: "this run has already settled" }),
  });
}
