import { NextResponse } from "next/server";
import { z } from "zod";

import { getAgent } from "@/agents/registry";
import { getLayout } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";
import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { requiredRunInputs } from "@/workflows/inputs";
import { deleteWorkflow, getWorkflow, readWorkflowSource, saveWorkflow } from "@/workflows/registry";
import { toWorkflowYaml, workflowGraphDocSchema } from "@/workflows/serialize";

export const runtime = "nodejs";

/**
 * Two ways to save the same file: the YAML editor sends text, the visual editor
 * sends the graph it is holding and the server writes the file for it. Either
 * way `saveWorkflow` validates before anything reaches disk.
 */
const saveSchema = z.union([
  z.object({ source: z.string().min(1).max(200_000) }).strict(),
  z.object({ graph: workflowGraphDocSchema }).strict(),
]);

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
  const source = "source" in parsed.data ? parsed.data.source : toWorkflowYaml(parsed.data.graph);
  try {
    return NextResponse.json(saveWorkflow(id, source));
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
