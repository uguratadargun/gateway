import { NextResponse } from "next/server";

import { getExecution, requestExecutionCancel } from "@/executions/store";
import { cancelExecution } from "@/executions/runner";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Stops a run. The engine settles the execution itself — cancelling only asks
 * it to — so this returns what it asked for, not a finished state.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (execution.status !== "running") {
    return NextResponse.json({ cancelled: false, reason: `run already ${execution.status}` });
  }
  // A run on someone's own machine cannot be aborted from here; the request is
  // recorded and the client picks it up on its next report, which is a moment
  // away rather than a wait. Either way the answer is "asked", not "stopped".
  if (execution.origin === "local") {
    const requested = requestExecutionCancel(id);
    return NextResponse.json({
      cancelled: requested,
      pending: requested,
      ...(requested ? {} : { reason: "this run has already settled" }),
    });
  }

  const cancelled = cancelExecution(id);
  return NextResponse.json({
    cancelled,
    ...(cancelled ? {} : { reason: "this run is not owned by this server process" }),
  });
}
