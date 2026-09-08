import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { availableSkills, importState, syncSource } from "@/skills/sources";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Fetch the library. Nothing a team runs changes here — syncing only updates
 * gate's clone, and the skills already imported keep saying what they said
 * until somebody imports them again.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const source = await syncSource(id);
  if (!source) return NextResponse.json({ error: "no such skill source" }, { status: 404 });
  const scope = scopeFromRequest(req, (t) => !!getTeam(t));
  return NextResponse.json({
    source,
    skills: availableSkills(source).map((skill) => ({ ...skill, state: importState(skill, scope) })),
  });
}
