import { NextResponse } from "next/server";

import { WorkflowError } from "@/runtime/errors";
import { resumeExecution } from "@/executions/runner";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Continues a stopped run as a new execution — same worktree, progress
 * reconstructed from history — rather than starting over from the entry node.
 * Refuses with a plain reason (still running, nothing ran yet, already
 * finished, worktree gone) rather than guessing.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { executionId } = resumeExecution(id);
    return NextResponse.json({ executionId }, { status: 202 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
