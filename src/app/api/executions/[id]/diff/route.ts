import { NextResponse } from "next/server";

import { getExecution, getExecutionDiff } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";
import { readRunDiff } from "@/runtime/workspace";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * What this run actually changed, as a unified diff read live from its worktree.
 *
 * Live and not stored: while the run is going the diff is whatever is in its
 * worktree now, and once it has ended — and the worktree with it — whatever
 * its branch holds.
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
    const { root, baseCommit, repo, branch } = execution.workspace;
    return NextResponse.json(readRunDiff(root, baseCommit, { repo, branch }));
  } catch (e) {
    const message = e instanceof WorkflowError ? e.message : "could not read the worktree";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
