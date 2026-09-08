import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentDefinitionError } from "@/agents/loader";
import { agentExists, deleteAgent, readAgentSource, saveAgent } from "@/agents/registry";
import { scopeFromRequest, teamScope } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { agentUsage } from "@/workflows/usage";
import { listWorkflows } from "@/workflows/registry";

export const runtime = "nodejs";

const moveSchema = z.object({ to: z.string().min(1).max(64) }).strict();

/**
 * Moves an agent to another team.
 *
 * Nothing refuses a move that leaves workflows behind naming an agent that is
 * no longer there — they are your files, and the same is true of deleting one.
 * What it does is say so: the workflows that will stop loading come back with
 * the answer, so it is a warned decision rather than a pipeline that breaks at
 * run time.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = moveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid move", issues: parsed.error.issues }, { status: 400 });

  const from = scopeFromRequest(req, (team) => !!getTeam(team));
  const target = getTeam(parsed.data.to);
  if (!target) return NextResponse.json({ error: `no team "${parsed.data.to}"` }, { status: 400 });
  if (target.id === from.teamId) return NextResponse.json({ error: "it is already in that team" }, { status: 400 });

  const to = teamScope(target.id);
  if (agentExists(id, to)) {
    return NextResponse.json({ error: `${target.name} already has an agent called "${id}"` }, { status: 409 });
  }

  try {
    const source = readAgentSource(id, from);
    const orphaned = agentUsage(listWorkflows(from).workflows).get(id) ?? [];
    saveAgent(id, source, to);
    deleteAgent(id, from);
    return NextResponse.json({ moved: true, to: target.id, orphaned });
  } catch (e) {
    if (e instanceof AgentDefinitionError) {
      const status = e.message === "agent not found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
