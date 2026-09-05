import { NextResponse } from "next/server";

import { deleteExecution, getExecution, getExecutionLineage, getResumedAs } from "@/executions/store";
import { getWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * A run plus the exact path it took — everything replay needs.
 *
 * "The path it took" spans a whole resume chain, not just this row: a
 * continued run's own steps pick up mid-workflow, so showing only its own
 * would render an empty graph and an empty step list until its first step
 * lands. The lineage already concatenates ancestors' steps with this one's
 * (oldest first) for planResume; the UI reads the same thing.
 */
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
  const steps = getExecutionLineage(id)?.steps ?? [];
  return NextResponse.json({ execution, steps, workflow, resumedAs: getResumedAs(id) });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ deleted: deleteExecution(id) });
}
