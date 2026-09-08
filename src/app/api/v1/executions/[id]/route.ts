import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { getExecution, getExecutionSteps } from "@/executions/store";

export const runtime = "nodejs";

/**
 * A run and every step it has taken.
 *
 * This is what a session-driven run reads to work out where it is: each
 * `gate next` is a new process, so the steps recorded here are the only memory
 * the walk has. Visible to the whole team, like the dashboard's own view of it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (execution.teamId !== auth.teamId) return NextResponse.json({ error: "not your team's run" }, { status: 403 });

  return NextResponse.json({ execution, steps: getExecutionSteps(id) });
}
