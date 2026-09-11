import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { scheduleExtraction } from "@/memory/queue";
import { memoryScopeFor, queueUnrecordedExecutions } from "@/memory/store";

export const runtime = "nodejs";

/**
 * Records the runs of a team's tree that ended before memory existed. Each
 * is a model call, so this is a button, not something that happens on its
 * own; the run pages show what came of each.
 */
export async function POST(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const queued = queueUnrecordedExecutions(memoryScopeFor(scope.teamId!).teams);
  if (queued) scheduleExtraction();
  return NextResponse.json({ queued });
}
