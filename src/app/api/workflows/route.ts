import { NextResponse } from "next/server";
import { z } from "zod";

import { WorkflowError } from "@/runtime/errors";
import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { listWorkflows, saveWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

const createSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(200_000) }).strict();

export async function GET() {
  ensureDefaultWorkflows();
  return NextResponse.json(listWorkflows());
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
