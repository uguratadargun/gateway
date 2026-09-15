import { NextResponse } from "next/server";

import { ownsExecution, requireClient } from "@/lib/tenancy";
import { getExecution, getExecutionSteps } from "@/executions/store";
import { publicationTarget, repoByIdentity } from "@/repos/store";

export const runtime = "nodejs";

/**
 * A run and every step it has taken.
 *
 * This is what a session-driven run reads to work out where it is: each
 * `gate next` is a new process, so the steps recorded here are the only memory
 * the walk has. Visible to the person who started it; the team's view is the
 * dashboard's.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });

  // Told on every poll, not only at start: a session-driven run re-reads its
  // own execution on each `gate next`, and this is what tells it where to
  // push the branch when it ends. Re-derived each time rather than trusted
  // from the start call, so a repository's publication settings taking
  // effect mid-run reach a run already going.
  const publish = execution.repoId ? publicationTarget(repoByIdentity(execution.repoId)) ?? null : null;
  return NextResponse.json({ execution, steps: getExecutionSteps(id), publish });
}
