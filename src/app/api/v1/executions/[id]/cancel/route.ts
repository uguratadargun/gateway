import { NextResponse } from "next/server";

import { ownsExecution, requireClient } from "@/lib/tenancy";
import { getExecution, requestExecutionCancel } from "@/executions/store";

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
  // A teammate may stop a run they can see; only its owner may report on it.
  if (execution.teamId !== auth.teamId) return NextResponse.json({ error: "not your team's run" }, { status: 403 });
  if (execution.status !== "running") {
    return NextResponse.json({ requested: false, reason: `run already ${execution.status}` });
  }
  return NextResponse.json({ requested: requestExecutionCancel(id) });
}
