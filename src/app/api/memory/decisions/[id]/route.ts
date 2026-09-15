import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { forgetDecision } from "@/memory/forget";
import { getDecision, memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Forgets one decision — the record and everything that pointed at it. Only a
 * team in the reader's own tree may be forgotten, the same boundary a search
 * reads within.
 */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const scope = scopeFromRequest(req, (teamId) => !!getTeam(teamId));
  const decision = getDecision(id);
  if (!decision) return NextResponse.json({ error: "no such decision" }, { status: 404 });
  if (!memoryScopeFor(scope.teamId!).teams.includes(decision.teamId)) {
    return NextResponse.json({ error: "that decision belongs to another tree" }, { status: 403 });
  }
  return NextResponse.json({ forgotten: forgetDecision(id) });
}
