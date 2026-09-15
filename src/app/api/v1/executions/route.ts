import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getAgent } from "@/agents/registry";
import { startRunSchema } from "@/lib/client-api-schemas";
import { requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { createExecution, listExecutions } from "@/executions/store";
import { taskVisibleTo } from "@/orchestration/tasks";
import { canonicalRepoId } from "@/repos/identity";
import { WorkflowError } from "@/runtime/errors";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { getWorkflow } from "@/workflows/registry";

export const runtime = "nodejs";

/**
 * The caller's own runs, for `gate status` and for a cockpit on their machine.
 *
 * A key names a person, and what that person sees here is what they started:
 * the team's runs together are the dashboard's view, behind the admin login,
 * not the client API's. A key with no person behind it (the server's own
 * `GATE_API_KEY`) has nothing to narrow by and sees its team's.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  return NextResponse.json({
    executions: listExecutions({ teamId: auth.teamId, userId: auth.userId ?? undefined, limit: Number.isFinite(limit) ? limit : 20 }),
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

    // A task the caller cannot see is not a task. Refused here rather than
    // stored, so a run never groups itself into another family's work.
    if (parsed.data.taskId && !taskVisibleTo(parsed.data.taskId, auth.teamId)) {
      return NextResponse.json({ error: "no such task", code: "TASK_NOT_FOUND" }, { status: 400 });
    }

    const executionId = randomUUID();
    createExecution(executionId, workflow.id, parsed.data.input, Date.now(), null, {
      origin: "local",
      taskId: parsed.data.taskId ?? null,
      driver: parsed.data.driver,
      userId: auth.userId,
      teamId: auth.teamId,
      // The identity is derived here, from the remote the client reported, so
      // every run names a repository the same way however old the client is.
      // An unparseable or absent remote leaves it null, never guessed.
      repoId: parsed.data.client.remoteUrl ? canonicalRepoId(parsed.data.client.remoteUrl) : null,
      client: {
        host: parsed.data.client.host ?? null,
        repo: parsed.data.client.repo ?? null,
        branch: parsed.data.client.branch ?? null,
        version: parsed.data.client.version ?? null,
        session: parsed.data.client.session ?? null,
      },
    });
    return NextResponse.json({ executionId }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
