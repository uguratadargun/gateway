import { NextResponse } from "next/server";
import { z } from "zod";

import { listAgents } from "@/agents/registry";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { serializeSkill, SkillDefinitionError } from "@/skills/loader";
import { deleteSkill, getSkill, readSkillSource, saveSkill } from "@/skills/registry";

export const runtime = "nodejs";

/**
 * A save arrives as raw Markdown or as frontmatter plus body — the same two
 * shapes the agent editor uses, for the same reason: the browser never
 * assembles YAML, and both paths go through one parse.
 */
const saveSchema = z.union([
  z.object({ source: z.string().min(1).max(200_000) }).strict(),
  z
    .object({
      frontmatter: z.record(z.string(), z.unknown()),
      body: z.string().max(200_000),
    })
    .strict(),
]);

type Params = { params: Promise<{ id: string }> };

const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

function fail(e: unknown): NextResponse | null {
  if (e instanceof SkillDefinitionError) {
    const status = e.message === "skill not found" ? 404 : 400;
    return NextResponse.json({ error: e.message, skillId: e.skillId }, { status });
  }
  return null;
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const scope = scopeOf(req);
  try {
    const skill = getSkill(id, scope);
    // Which agents work by this skill: deleting one is then a warned decision
    // rather than an agent that stops resolving on its next save.
    const usedBy = listAgents(scope).agents.filter((a) => a.skills.includes(id)).map((a) => a.id);
    return NextResponse.json({ skill, source: readSkillSource(id, scope), usedBy });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid skill", issues: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  const source = "source" in body ? body.source : serializeSkill(body.frontmatter, body.body);
  try {
    return NextResponse.json({ skill: saveSkill(id, source, scopeOf(req)), source });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json({ deleted: deleteSkill(id, scopeOf(req)) });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
