import { NextResponse } from "next/server";

import { getExecution } from "@/executions/store";
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
  const cancelled = cancelExecution(id);
  return NextResponse.json({
    cancelled,
    ...(cancelled ? {} : { reason: "this run is not owned by this server process" }),
  });
}
