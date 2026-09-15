import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { forgetFeature } from "@/memory/forget";
import { getFeature, memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Forgets a catalogue entry and everything filed under it: every team's page
 * on it, its consolidation history, and its decisions. The catalogue belongs
 * to the root of a tree, so that is the boundary checked here.
 */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const scope = scopeFromRequest(req, (teamId) => !!getTeam(teamId));
  const feature = getFeature(id);
  if (!feature) return NextResponse.json({ error: "no such feature" }, { status: 404 });
  if (feature.orgId !== memoryScopeFor(scope.teamId!).orgId) {
    return NextResponse.json({ error: "that feature belongs to another tree" }, { status: 403 });
  }
  return NextResponse.json({ forgotten: forgetFeature(id) });
}
