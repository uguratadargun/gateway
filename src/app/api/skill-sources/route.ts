import { NextResponse } from "next/server";
import { z } from "zod";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { WorkflowError } from "@/runtime/errors";
import { availableSkills, createSource, importState, listSources } from "@/skills/sources";

export const runtime = "nodejs";

const createSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes"),
    name: z.string().max(100).default(""),
    url: z.string().min(1).max(500),
    ref: z.string().max(200).optional(),
    subdir: z.string().max(200).default("skills"),
    /**
     * Two libraries both shipping "brainstorming" is the normal case, not the
     * exception, so the prefix is offered rather than discovered the hard way.
     */
    prefix: z.string().max(32).default(""),
  })
  .strict();

const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

/**
 * The libraries this gate can pull from, and where each of their skills stands
 * against the team looking: not here yet, current, behind upstream, or changed
 * locally. That last one is the answer that decides whether an update is safe.
 */
export async function GET(req: Request) {
  const scope = scopeOf(req);
  const sources = listSources().map((source) => ({
    ...source,
    skills: availableSkills(source).map((skill) => ({ ...skill, state: importState(skill, scope) })),
  }));
  return NextResponse.json({ sources });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid source", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(createSource(parsed.data));
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
