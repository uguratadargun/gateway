import { NextResponse } from "next/server";

import { getExecution } from "@/executions/store";
import { ownsExecution, requireClient } from "@/lib/tenancy";
import { memoryOfExecution } from "@/memory/store";

export const runtime = "nodejs";

/**
 * What the recorder made of a run: its ledger row and its decisions. What
 * `gate teach` waits on, so the person sees what was learnt without opening
 * the dashboard. Visible to the person who started the run.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });

  return NextResponse.json(memoryOfExecution(id));
}
