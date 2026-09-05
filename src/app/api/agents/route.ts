import { NextResponse } from "next/server";
import { z } from "zod";

import { ensureDefaultAgents } from "@/agents/defaults";
import { AgentDefinitionError } from "@/agents/loader";
import { listAgents, saveAgent } from "@/agents/registry";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(100_000) }).strict();

export async function GET() {
  ensureDefaultAgents();
  return NextResponse.json(listAgents());
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveAgent(parsed.data.id, parsed.data.source));
  } catch (e) {
    if (e instanceof AgentDefinitionError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
