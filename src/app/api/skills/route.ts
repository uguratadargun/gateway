import { NextResponse } from "next/server";
import { z } from "zod";

import { DEFAULT_AGENT_SKILLS } from "@/agents/defaults";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { SkillDefinitionError } from "@/skills/loader";
import { inheritedSkills, listSkills, saveSkill } from "@/skills/registry";
import { skillSummary } from "@/skills/types";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(200_000) }).strict();

const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

/**
 * The team's skill library.
 *
 * Bodies are left out of the list: a library of a dozen skills is a hundred
 * kilobytes of prose, and the page shows names, descriptions and where each
 * one came from. The body is what the editor fetches, one skill at a time.
 */
export async function GET(req: Request) {
  const scope = scopeOf(req);
  const { skills, errors } = listSkills(scope);
  const inherited = inheritedSkills(scope);
  const have = new Set([...skills, ...inherited].map((s) => s.id));
  return NextResponse.json({
    skills: skills.map(skillSummary),
    inherited: inherited.map(skillSummary),
    errors,
    // What the shipped agents follow and this team has not got. A default that
    // names a skill nobody can see is a run that fails halfway through, with a
    // message about a library the person has never opened — so the page can
    // say it here instead, next to the button that fixes it.
    missingForDefaults: DEFAULT_AGENT_SKILLS.filter((s) => !have.has(s.id)),
  });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid skill", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(skillSummary(saveSkill(parsed.data.id, parsed.data.source, scopeOf(req))));
  } catch (e) {
    if (e instanceof SkillDefinitionError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
