import { NextResponse } from "next/server";
import { z } from "zod";

import { getAgent } from "@/agents/registry";
import { WorkflowError } from "@/runtime/errors";
import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { requiredRunInputs } from "@/workflows/inputs";
import { inheritedWorkflows, listWorkflows, saveWorkflow } from "@/workflows/registry";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(200_000) }).strict();

/**
 * Each workflow carries the run-input keys it needs, so a caller that only has
 * this list — the dashboard, or the shell/slash-command client — can build a
 * valid run without loading every definition itself.
 */
const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

export async function GET(req: Request) {
  const scope = scopeOf(req);
  ensureDefaultWorkflows(scope);
  const { workflows, errors } = listWorkflows(scope);
  const withInputs = (wf: Parameters<typeof requiredRunInputs>[0]) => ({
    ...wf,
    inputs: requiredRunInputs(wf, (id) => getAgent(id, scope)),
  });
  return NextResponse.json({
    workflows: workflows.map(withInputs),
    errors,
    // Runnable by this team, owned by the default team. See the agents route.
    inherited: inheritedWorkflows(scope).map(withInputs),
  });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid workflow", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveWorkflow(parsed.data.id, parsed.data.source, scopeOf(req)));
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
