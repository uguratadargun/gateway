import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { LocalMemoryAccess, toFeatureCard } from "@/memory/access";
import { consolidationsOf } from "@/memory/consolidate";
import { listFeatures, memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

/** The catalogue of the team's tree, newest first; `?id=` reads one in full. */
export async function GET(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const detail = await new LocalMemoryAccess(scope.teamId!).feature(id);
    if (!detail) return NextResponse.json({ error: "no such feature" }, { status: 404 });
    const consolidations = consolidationsOf(id).map((c) => ({
      team: c.teamId,
      status: c.status,
      at: new Date(c.startedAt).toISOString(),
      model: c.model,
      costUsd: c.costUsd,
      decisionsRead: c.decisionsRead,
      superseded: c.superseded,
      error: c.error,
    }));
    return NextResponse.json({ ...detail, consolidations });
  }
  const memoryScope = memoryScopeFor(scope.teamId!);
  return NextResponse.json({ scope: { own: memoryScope.own, teams: memoryScope.teams }, features: listFeatures(memoryScope).map((f) => toFeatureCard(f)) });
}
