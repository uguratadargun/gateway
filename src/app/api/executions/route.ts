import { NextResponse } from "next/server";
import { z } from "zod";

import { startExecution } from "@/executions/runner";
import { listExecutions } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";

export const runtime = "nodejs";

const runSchema = z
  .object({
    workflowId: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workflowId = url.searchParams.get("workflowId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({ executions: listExecutions({ workflowId, limit: Number.isFinite(limit) ? limit : 50 }) });
}

/** Starts a run and returns immediately; progress arrives over the SSE stream. */
export async function POST(req: Request) {
  const parsed = runSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid run request", issues: parsed.error.issues }, { status: 400 });
  try {
    const { executionId } = startExecution(parsed.data.workflowId, parsed.data.input);
    return NextResponse.json({ executionId }, { status: 202 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
