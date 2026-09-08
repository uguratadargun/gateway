import { NextResponse } from "next/server";

import { getExecution, getExecutionDiff } from "@/executions/store";
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

  // A local run's worktree is on the machine that made it, so the diff is the
  // one that machine uploaded when it finished — a snapshot, not a live read.
  if (execution.origin === "local") {
    const diff = getExecutionDiff(id);
    if (diff === null) {
      return NextResponse.json(
        { error: `this run worked on ${execution.client?.host ?? "another machine"}; its diff has not been reported yet` },
        { status: 409 },
      );
    }
    return NextResponse.json({ diff, truncated: false, remote: true });
  }

  try {
    return NextResponse.json(readRunDiff(execution.workspace.root, execution.workspace.baseCommit));
  } catch (e) {
    const message = e instanceof WorkflowError ? e.message : "could not read the worktree";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
