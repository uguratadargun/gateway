import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { LocalMemoryAccess, toFeatureCard } from "@/memory/access";
import { listFeatures, memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

/** The catalogue of the team's tree, newest first; `?id=` reads one in full. */
export async function GET(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const detail = await new LocalMemoryAccess(scope.teamId!).feature(id);
    if (!detail) return NextResponse.json({ error: "no such feature" }, { status: 404 });
    return NextResponse.json(detail);
  }
  const memoryScope = memoryScopeFor(scope.teamId!);
  return NextResponse.json({ scope: { own: memoryScope.own, teams: memoryScope.teams }, features: listFeatures(memoryScope).map((f) => toFeatureCard(f)) });
}
