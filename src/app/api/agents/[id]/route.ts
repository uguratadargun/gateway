import { NextResponse } from "next/server";
import { z } from "zod";

import { ensureDefaultAgents } from "@/agents/defaults";
import { AgentDefinitionError, serializeAgent } from "@/agents/loader";
import { deleteAgent, getAgent, readAgentSource, saveAgent } from "@/agents/registry";
import { scopeFromRequest, type DefinitionScope } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { FIELD_TYPES } from "@/agents/types";
import { fetchAvailableModels } from "@/lib/models";
import { EFFORTS } from "@/lib/reasoning";
import { knownToolNames } from "@/runtime/tools/registry";
import { inheritedSkills, listSkills } from "@/skills/registry";

export const runtime = "nodejs";

/**
 * The vocabularies the editor's form needs — efforts, field types, executors,
 * gate's tool names, the account's models.
 *
 * They are served rather than duplicated in the browser because every one of
 * them lives in a module that reaches for `node:fs` somewhere down its import
 * chain. A hard-coded copy in a React component is a copy that drifts the
 * first time a tool is added and nobody remembers the second list exists.
 */
async function editorOptions(scope: DefinitionScope) {
  const { models, source } = await fetchAvailableModels();
  // The team's own skills and the ones it inherits, in one list: an agent
  // naming either resolves, and which library a skill lives in is not a
  // distinction the person assigning it has to hold in their head.
  const skills = [...listSkills(scope).skills, ...inheritedSkills(scope)]
    .map((s) => ({ id: s.id, name: s.name, description: s.description }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    // Tier aliases first: this is what an agent file normally says, and the
    // router resolves it per run against whatever the account actually has.
    modelTiers: ["haiku", "sonnet", "opus", "fable"],
    models,
    modelSource: source,
    efforts: EFFORTS,
    executors: ["gate", "claude-code"],
    fieldTypes: FIELD_TYPES,
    gateTools: knownToolNames(),
    skills,
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
    return NextResponse.json({ agent, source, options: await editorOptions(scope) });
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
