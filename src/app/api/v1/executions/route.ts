import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getAgent } from "@/agents/registry";
import { startRunSchema } from "@/lib/client-api-schemas";
import { requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { createExecution, listExecutions } from "@/executions/store";
import { WorkflowError } from "@/runtime/errors";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { getWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

/** This team's runs, for `gate status`. */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  return NextResponse.json({
    executions: listExecutions({ teamId: auth.teamId, limit: Number.isFinite(limit) ? limit : 20 }),
  });
}

/**
 * Registers a run that is about to start on the caller's machine.
 *
 * The server validates the same two things it would validate for its own run —
 * that the workflow exists in this team, and that the input it needs is there —
 * so a run that could never work is refused before a worktree is created. It
 * does not start anything: the engine is on the other end of this call.
 */
export async function POST(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  const parsed = startRunSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid run request", issues: parsed.error.issues }, { status: 400 });
  }
  const scope = scopeForPrincipal(auth);

  try {
    const workflow = getWorkflow(parsed.data.workflowId, scope);
    const missing = missingRunInputs(requiredRunInputs(workflow, (id) => getAgent(id, scope)), parsed.data.input);
    if (missing.length) {
      return NextResponse.json(
        {
          error: `this workflow needs ${missing.length > 1 ? "run inputs" : "a run input"}: ${missing.join(", ")}`,
          code: "RUN_INPUT_MISSING",
          missing,
        },
        { status: 400 },
      );
    }

    const executionId = randomUUID();
    createExecution(executionId, workflow.id, parsed.data.input, Date.now(), null, {
      origin: "local",
      userId: auth.userId,
      teamId: auth.teamId,
      client: {
        host: parsed.data.client.host ?? null,
        repo: parsed.data.client.repo ?? null,
        branch: parsed.data.client.branch ?? null,
        version: parsed.data.client.version ?? null,
      },
    });
    return NextResponse.json({ executionId }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
