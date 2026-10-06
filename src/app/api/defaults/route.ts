import { NextResponse } from "next/server";

import { DEFAULT_AGENTS, writeMissingDefaultAgents } from "@/agents/defaults";
import { agentExists } from "@/agents/registry";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { DEFAULT_WORKFLOWS, writeMissingDefaultWorkflows } from "@/workflows/defaults";
import { workflowExists } from "@/workflows/registry";

export const runtime = "nodejs";

/**
 * The full scope, inheritance included — not `ownScope`. A team that reaches
 * the shipped planner through the default team is not missing it, and was
 * being told it was: every team but the default saw the warning on its first
 * visit, and pressing Restore would have shadowed the house library's copy
 * with one of its own. The write itself goes to the team's own directory;
 * `writeMissingDefault*` see to that.
 */
const scopeOf = (req: Request) => scopeFromRequest(req, (id) => !!getTeam(id));

/**
 * Putting the shipped definitions back, on purpose.
 *
 * Seeding only ever fires when a team's directory does not exist, so that
 * deleting a default sticks — which is right, and leaves two cases with no way
 * out: a team that cleared everything, and a team that was seeded by an older
 * gate and never sees the ones a new version ships. Both want the same thing
 * and neither should get it silently.
 *
 * Nothing is overwritten. A shipped id the team already has is left exactly as
 * it is, edits and all; only what is absent is written.
 */
export async function GET(req: Request) {
  const scope = scopeOf(req);
  return NextResponse.json({
    agents: Object.keys(DEFAULT_AGENTS).filter((id) => !agentExists(id, scope)),
    workflows: Object.keys(DEFAULT_WORKFLOWS).filter((id) => !workflowExists(id, scope)),
  });
}

export async function POST(req: Request) {
  const scope = scopeOf(req);
  // Agents first: a workflow naming one that is not there yet would not load.
  const added = [...writeMissingDefaultAgents(scope), ...writeMissingDefaultWorkflows(scope)];
  return NextResponse.json({ added });
}
