import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentDefinitionError } from "@/agents/loader";
import { agentExists, deleteAgent, listAgents, saveAgent } from "@/agents/registry";
import { ownScope } from "@/lib/def-root";
import { clientErrorResponse, requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { WorkflowError } from "@/runtime/errors";
import { deleteWorkflow, listWorkflows, saveWorkflow, workflowExists } from "@/workflows/registry";

export const runtime = "nodejs";

const saveSchema = z
  .object({
    kind: z.enum(["agent", "workflow"]),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes"),
    source: z.string().min(1).max(200_000),
    /** Overwriting someone's definition is a decision, so it is said out loud. */
    replace: z.boolean().default(false),
  })
  .strict();

/**
 * Writing a definition from the machine it was designed on.
 *
 * The rest of the client API is read-only on purpose — a team's definitions are
 * the team's, and a mirror that could write back would make "what does this
 * team run" a question with several answers. But designing a pipeline happens
 * where the repository is, and making that person copy five files into a web
 * form is the friction the whole client exists to remove.
 *
 * So it is a scope, not a mode: only a key issued with `author` may write, it
 * writes only into its own team, and it goes through exactly the validation the
 * dashboard's editor does — an agent that does not parse or a workflow naming
 * an agent that is not there is refused with the reason, never half-saved.
 */
export async function POST(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  if (!auth.scopes.includes("author")) {
    return clientErrorResponse({
      status: 403,
      error: "this key may read your team's definitions but not write them — ask for a key with the author right",
      code: "SCOPE_MISSING",
    });
  }

  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid definition", issues: parsed.error.issues }, { status: 400 });
  }
  const { kind, id, source, replace } = parsed.data;
  const scope = scopeForPrincipal(auth);

  // What this team owns. Writing a name it currently inherits from the default
  // team is not an overwrite — it is this team taking its own copy.
  const own = ownScope(scope);
  const exists = kind === "agent" ? agentExists(id, own) : workflowExists(id, own);
  if (exists && !replace) {
    return NextResponse.json(
      { error: `"${id}" already exists in your team — pass replace to overwrite it, or pick another id`, code: "EXISTS" },
      { status: 409 },
    );
  }

  try {
    const saved = kind === "agent" ? saveAgent(id, source, scope) : saveWorkflow(id, source, scope);
    return NextResponse.json({ saved: true, kind, id, replaced: exists, name: saved.name });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    if (e instanceof AgentDefinitionError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/**
 * Deletes every definition the caller's team owns — `gate reset --team`.
 *
 * The team's own id has to come back as `?confirm=`, which is not a
 * cryptographic measure: it is there so this cannot be reached by a mistyped
 * URL or a copied curl line, the way a bare DELETE on a collection can. What
 * the team *inherits* is not touched, because it is not this team's to delete.
 */
export async function DELETE(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  if (!auth.scopes.includes("author")) {
    return clientErrorResponse({
      status: 403,
      error: "this key may read your team's definitions but not delete them — ask for a key with the author right",
      code: "SCOPE_MISSING",
    });
  }
  if (new URL(req.url).searchParams.get("confirm") !== auth.teamId) {
    return clientErrorResponse({
      status: 400,
      error: `pass ?confirm=${auth.teamId} to delete everything that team owns`,
      code: "CONFIRM_REQUIRED",
    });
  }

  // Own scope only: the shared library belongs to the default team.
  const scope = ownScope(scopeForPrincipal(auth));
  const { workflows, errors } = listWorkflows(scope);
  let removedWorkflows = 0;
  // Broken files count too — a definition that no longer parses is still one
  // of this team's, and leaving it behind would make "reset" a lie.
  for (const id of [...workflows.map((w) => w.id), ...errors.map((e) => e.id)]) {
    if (deleteWorkflow(id, scope)) removedWorkflows++;
  }
  const agents = listAgents(scope);
  let removedAgents = 0;
  for (const id of [...agents.agents.map((a) => a.id), ...agents.errors.map((e) => e.id)]) {
    if (deleteAgent(id, scope)) removedAgents++;
  }
  return NextResponse.json({ agents: removedAgents, workflows: removedWorkflows });
}
