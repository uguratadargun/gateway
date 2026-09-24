import { NextResponse } from "next/server";

import { listExecutions } from "@/executions/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workflowId = url.searchParams.get("workflowId") ?? undefined;
  const teamId = url.searchParams.get("team") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({
    executions: listExecutions({ workflowId, teamId, limit: Number.isFinite(limit) ? limit : 50 }),
  });
}
