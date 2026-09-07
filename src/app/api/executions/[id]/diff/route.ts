import { NextResponse } from "next/server";

import { getExecution } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";
import { readRunDiff } from "@/runtime/workspace";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * What this run actually changed, as a unified diff read live from its worktree.
 *
 * Live and not stored: the worktree is the deliverable and it outlives the run,
 * so the diff is whatever is in it now — which is also what makes this useful
 * while a run is still going.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (!execution.workspace) return NextResponse.json({ error: "this run had no workspace" }, { status: 404 });
  try {
    return NextResponse.json(readRunDiff(execution.workspace.root));
  } catch (e) {
    const message = e instanceof WorkflowError ? e.message : "could not read the worktree";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
