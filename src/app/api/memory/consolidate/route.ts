import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { loadSettings } from "@/lib/settings";
import { getTeam } from "@/lib/teams";
import { consolidateImplementation, consolidationsOf } from "@/memory/consolidate";
import { memoryScopeFor } from "@/memory/store";
import { GateModelProvider } from "@/providers/gate-provider";

export const runtime = "nodejs";

/**
 * One consolidation pass, now, over one team's page on one feature — the
 * button on the feature. Waits for it: a page rewritten is what the person
 * pressed for, and it is one model call.
 */
export async function POST(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const url = new URL(req.url);
  const featureId = url.searchParams.get("id")?.trim();
  const teamId = url.searchParams.get("teamId")?.trim() || scope.teamId!;
  if (!featureId) return NextResponse.json({ error: "which feature?" }, { status: 400 });
  const memoryScope = memoryScopeFor(scope.teamId!);
  if (!memoryScope.teams.includes(teamId)) return NextResponse.json({ error: "that team is not in this tree" }, { status: 403 });
  const outcome = await consolidateImplementation(memoryScope, featureId, teamId, new GateModelProvider(), { model: loadSettings().memory.model });
  return NextResponse.json({ ...outcome, consolidations: consolidationsOf(featureId) });
}
