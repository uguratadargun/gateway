import { NextResponse } from "next/server";
import { z } from "zod";

import { ensureDefaultAgents } from "@/agents/defaults";
import { AgentDefinitionError } from "@/agents/loader";
import { inheritedAgents, listAgents, saveAgent } from "@/agents/registry";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(100_000) }).strict();

const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

export async function GET(req: Request) {
  const scope = scopeOf(req);
  ensureDefaultAgents(scope);
  // `inherited` is what this team can use but does not own: the default team's
  // library, minus anything this team has replaced. Read-only here — it is
  // edited where it lives.
  return NextResponse.json({ ...listAgents(scope), inherited: inheritedAgents(scope) });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveAgent(parsed.data.id, parsed.data.source, scopeOf(req)));
  } catch (e) {
    if (e instanceof AgentDefinitionError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
