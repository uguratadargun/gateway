import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { listAgents, readAgentSource } from "@/agents/registry";
import { getAgent } from "@/agents/registry";
import { requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { requiredRunInputs } from "@/workflows/inputs";
import { listWorkflows, readWorkflowSource } from "@/workflows/registry";

export const runtime = "nodejs";

function sha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/**
 * Everything a client needs to run this team's pipelines on its own machine:
 * the agent and workflow *sources*, not a parsed form. The client parses them
 * with the same loader the server does, so a definition means one thing
 * wherever it runs, and a file that fails validation fails identically.
 *
 * The bundle carries a hash of itself. `gate pull` sends it back as
 * `If-None-Match`, so an unchanged team costs one 304 rather than a copy of
 * every file — and the same hash is what the client records when the user
 * approves what a workflow is allowed to run on their machine.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const scope = scopeForPrincipal(auth);

  // A team that has never been opened has no files yet; seed it the same way
  // the dashboard does on first visit.
  ensureDefaultWorkflows(scope);

  const agents = listAgents(scope).agents.map((a) => {
    const source = readAgentSource(a.id, scope);
    return { id: a.id, name: a.name, source, sha: sha(source) };
  });

  const { workflows, errors } = listWorkflows(scope);
  const bundled = workflows.map((wf) => {
    const source = readWorkflowSource(wf.id, scope);
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description ?? null,
      inputs: requiredRunInputs(wf, (id) => getAgent(id, scope)),
      nodeCount: wf.nodes.length,
      workspace: wf.workspace ?? null,
      source,
      sha: sha(source),
    };
  });

  const hash = createHash("sha256")
    .update([...agents.map((a) => `a:${a.id}:${a.sha}`), ...bundled.map((w) => `w:${w.id}:${w.sha}`).sort()].join("\n"))
    .digest("hex")
    .slice(0, 16);

  const etag = `"${hash}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return NextResponse.json(
    { team: auth.teamId, hash, agents, workflows: bundled, errors },
    { headers: { ETag: etag } },
  );
}
