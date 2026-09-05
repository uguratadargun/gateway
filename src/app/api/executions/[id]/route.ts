import { NextResponse } from "next/server";

import { deleteExecution, getExecution, getExecutionSteps, getResumedAs } from "@/executions/store";
import { getWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** A run plus the exact path it took — everything replay needs. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  let workflow = null;
  try {
    workflow = getWorkflow(execution.workflowId);
  } catch {
    // The definition may have been edited or removed since the run; steps stand alone.
  }
  return NextResponse.json({ execution, steps: getExecutionSteps(id), workflow, resumedAs: getResumedAs(id) });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ deleted: deleteExecution(id) });
}
