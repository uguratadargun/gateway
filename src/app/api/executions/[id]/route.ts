import { NextResponse } from "next/server";

import { deleteExecution, getExecution, getExecutionDefinitions, getExecutionLineage, getResumedAs } from "@/executions/store";
import { teamScope } from "@/lib/def-root";
import { getWorkflow } from "@/workflows/registry";
import { pinnedDefinitions } from "@/workflows/snapshot";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * A run plus the exact path it took — everything replay needs.
 *
 * "The path it took" spans a whole resume chain, not just this row: a run
 * the dashboard once continued as a new row picks up mid-workflow, so showing
 * only its own steps would render an empty graph and an empty step list. The
 * lineage concatenates ancestors' steps with this one's, oldest first. Only
 * runs recorded before 0.47.0 have ancestors; `gate continue` reopens the
 * same row.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  // The graph the run actually walked, kept with the run itself. Editing a
  // workflow used to redraw every past run that had used it — nodes that moved,
  // nodes that were never there — and the steps below would line up against a
  // graph nobody had walked.
  let workflow = pinnedDefinitions(getExecutionDefinitions(id))?.workflow ?? null;
  try {
    // No snapshot: a run from before they were kept. Read from the run's own
    // team — the same workflow id can exist in two — and accept that this is
    // the definition as it is now rather than as the run found it.
    if (!workflow) workflow = getWorkflow(execution.workflowId, teamScope(execution.teamId));
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
