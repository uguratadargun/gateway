import { NextResponse } from "next/server";

import { publishWorkflowEvent } from "@/events/bus";
import { ownsExecution, requireClient } from "@/lib/tenancy";
import { getExecution, reopenSessionExecution } from "@/executions/store";

export const runtime = "nodejs";

/**
 * `gate continue`: a session-driven run that failed is reopened so the node
 * it failed on runs again, in the same worktree, with everything before it
 * kept.
 *
 * Only the session that drove it can continue it — the worktree is on that
 * machine — which is why this is a client route and not the dashboard's
 * Continue, which resumes a run the server itself can pick up. The failed
 * attempt is dropped from the history so the session's replay lands on the
 * node as if it had never run; the reason it failed stays in the events the
 * dashboard already showed.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;

  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "no such run" }, { status: 404 });
  if (!ownsExecution(execution, auth)) return NextResponse.json({ error: "not your run" }, { status: 403 });
  if (execution.driver !== "session") {
    return NextResponse.json({ continued: false, reason: "only a run driven from a session can be continued this way" });
  }
  if (execution.status === "running") {
    return NextResponse.json({ continued: false, reason: "this run is still going — `gate next` picks it up" });
  }
  if (execution.status === "completed") {
    return NextResponse.json({ continued: false, reason: "this run finished; there is nothing to continue" });
  }

  const at = Date.now();
  const reopened = reopenSessionExecution(id, at);
  if (!reopened) return NextResponse.json({ continued: false, reason: "this run cannot be reopened" });
  publishWorkflowEvent({ type: "workflow.continued", executionId: id, at, retried: reopened.retried } as never);
  return NextResponse.json({ continued: true, retried: reopened.retried });
}
