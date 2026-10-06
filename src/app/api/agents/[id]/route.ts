import { NextResponse } from "next/server";
import { z } from "zod";

import { ensureDefaultAgents } from "@/agents/defaults";
import { AgentDefinitionError, serializeAgent } from "@/agents/loader";
import { deleteAgent, getAgent, readAgentSource, saveAgent } from "@/agents/registry";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { FIELD_TYPES } from "@/agents/types";
import { EFFORTS } from "@/lib/reasoning";
import { knownToolNames } from "@/agents/tools";

export const runtime = "nodejs";

/**
 * Concrete Claude ids an agent may pin. A node runs on the person's own Claude
 * Code login, so this is a list of names Claude Code accepts, not of what any
 * account here serves; an id not in it still loads, and the editor keeps it.
 */
const CLAUDE_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

/**
 * The vocabularies the editor's form needs — efforts, field types, executors,
 * gate's tool names, and the Claude models an agent may name.
 *
 * They are served rather than duplicated in the browser because every one of
 * them lives in a module that reaches for `node:fs` somewhere down its import
 * chain. A hard-coded copy in a React component is a copy that drifts the
 * first time a tool is added and nobody remembers the second list exists.
 */
async function editorOptions() {
  return {
    // Aliases first: this is what an agent file normally says, and Claude
    // Code resolves it to the newest model of that name.
    modelTiers: ["haiku", "sonnet", "opus", "fable"],
    models: CLAUDE_MODELS,
    efforts: EFFORTS,
    executors: ["gate", "claude-code"],
    fieldTypes: FIELD_TYPES,
    gateTools: knownToolNames(),
  };
}

/**
 * A save arrives one of two ways: `source` is the raw Markdown, straight from
 * the editor's Markdown mode; `frontmatter` + `prompt` is the form, which
 * never assembles YAML in the browser. Both go through the same parse, so an
 * invalid definition is refused identically and never reaches disk.
 */
const saveSchema = z.union([
  z.object({ source: z.string().min(1).max(100_000) }).strict(),
  z
    .object({
      frontmatter: z.record(z.string(), z.unknown()),
      prompt: z.string().max(100_000),
    })
    .strict(),
]);

type Params = { params: Promise<{ id: string }> };

const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

function fail(e: unknown): NextResponse | null {
  if (e instanceof AgentDefinitionError) {
    const status = e.message === "agent not found" ? 404 : 400;
    return NextResponse.json({ error: e.message, agentId: e.agentId }, { status });
  }
  return null;
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const scope = scopeOf(req);
  ensureDefaultAgents(scope);
  try {
    const agent = getAgent(id, scope);
    const source = readAgentSource(id, scope);
    return NextResponse.json({ agent, source, options: await editorOptions() });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  const source = "source" in body ? body.source : serializeAgent(body.frontmatter, body.prompt);
  try {
    return NextResponse.json({ agent: saveAgent(id, source, scopeOf(req)), source });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json({ deleted: deleteAgent(id, scopeOf(req)) });
  } catch (e) {
    return fail(e) ?? NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
