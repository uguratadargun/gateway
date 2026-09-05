import { NextResponse } from "next/server";
import { z } from "zod";

import { ensureDefaultAgents } from "@/agents/defaults";
import { AgentDefinitionError } from "@/agents/loader";
import { deleteAgent, getAgent, readAgentSource, saveAgent } from "@/agents/registry";

export const runtime = "nodejs";

const saveSchema = z.object({ source: z.string().min(1).max(100_000) }).strict();

type Params = { params: Promise<{ id: string }> };

function fail(e: unknown): NextResponse | null {
  if (e instanceof AgentDefinitionError) {
    const status = e.message === "agent not found" ? 404 : 400;
    return NextResponse.json({ error: e.message, agentId: e.agentId }, { status });
  }
  return null;
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  ensureDefaultAgents();
  try {
    return NextResponse.json({ agent: getAgent(id), source: readAgentSource(id) });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveAgent(id, parsed.data.source));
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json({ deleted: deleteAgent(id) });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
