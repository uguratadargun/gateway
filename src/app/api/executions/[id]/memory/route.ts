import { NextResponse } from "next/server";

import { getExecution } from "@/executions/store";
import { scheduleExtraction } from "@/memory/queue";
import { memoryOfExecution, requeueExtraction } from "@/memory/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** What the recorder made of this run: the ledger row, and the decisions. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!getExecution(id)) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  return NextResponse.json(memoryOfExecution(id));
}

/** Asks for the run to be recorded again — after a failure, or a fix to the recorder. */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (execution.status === "running") return NextResponse.json({ error: "the run is still going" }, { status: 409 });
  const requeued = requeueExtraction(id);
  if (requeued) scheduleExtraction();
  return NextResponse.json({ requeued, ...memoryOfExecution(id) });
}
