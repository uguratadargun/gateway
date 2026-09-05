import { NextResponse } from "next/server";
import { z } from "zod";

import { getAgent } from "@/agents/registry";
import { getLayout } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";
import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { requiredRunInputs } from "@/workflows/inputs";
import { deleteWorkflow, getWorkflow, readWorkflowSource, saveWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

const saveSchema = z.object({ source: z.string().min(1).max(200_000) }).strict();

type Params = { params: Promise<{ id: string }> };

function fail(e: unknown): NextResponse {
  if (e instanceof WorkflowError) {
    const status = e.message === "workflow not found" ? 404 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 400 });
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  ensureDefaultWorkflows();
  try {
    const workflow = getWorkflow(id);
    return NextResponse.json({
      workflow,
      source: readWorkflowSource(id),
      layout: getLayout(id),
      requiredInput: requiredRunInputs(workflow, getAgent),
    });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid workflow", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(saveWorkflow(id, parsed.data.source));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json({ deleted: deleteWorkflow(id) });
  } catch (e) {
    return fail(e);
  }
}
