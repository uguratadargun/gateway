import { NextResponse } from "next/server";
import { z } from "zod";

import { getAgent } from "@/agents/registry";
import { WorkflowError } from "@/runtime/errors";
import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { requiredRunInputs } from "@/workflows/inputs";
import { listWorkflows, saveWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(200_000) }).strict();

/**
 * Each workflow carries the run-input keys it needs, so a caller that only has
 * this list — the dashboard, or the shell/slash-command client — can build a
 * valid run without loading every definition itself.
 */
export async function GET() {
  ensureDefaultWorkflows();
  const { workflows, errors } = listWorkflows();
  return NextResponse.json({
    workflows: workflows.map((wf) => ({ ...wf, inputs: requiredRunInputs(wf, getAgent) })),
    errors,
  });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid workflow", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveWorkflow(parsed.data.id, parsed.data.source));
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
