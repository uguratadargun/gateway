import { NextResponse } from "next/server";
import { z } from "zod";

import { WorkflowError } from "@/runtime/errors";
import { scopeFromRequest, teamScope } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { deleteWorkflow, readWorkflowSource, saveWorkflow, workflowExists } from "@/workflows/registry";

export const runtime = "nodejs";

const moveSchema = z.object({ to: z.string().min(1).max(64) }).strict();

/**
 * Moves a workflow to another team.
 *
 * A definition belongs to exactly one team — that is what makes "this team's
 * workflows" a set anyone can reason about — so assigning it elsewhere is a
 * move, not a copy. It is written into the destination *first*, through the
 * same validation a hand-edited file gets: a workflow naming agents the
 * destination does not have is refused with that reason and nothing is
 * touched, rather than landing there broken and disappearing from where it
 * worked.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = moveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid move", issues: parsed.error.issues }, { status: 400 });

  const from = scopeFromRequest(req, (team) => !!getTeam(team));
  const target = getTeam(parsed.data.to);
  if (!target) return NextResponse.json({ error: `no team "${parsed.data.to}"` }, { status: 400 });
  if (target.id === from.teamId) return NextResponse.json({ error: "it is already in that team" }, { status: 400 });

  const to = teamScope(target.id);
  if (workflowExists(id, to)) {
    return NextResponse.json({ error: `${target.name} already has a workflow called "${id}"` }, { status: 409 });
  }

  try {
    const source = readWorkflowSource(id, from);
    saveWorkflow(id, source, to);
    deleteWorkflow(id, from);
    return NextResponse.json({ moved: true, to: target.id });
  } catch (e) {
    if (e instanceof WorkflowError) {
      const status = e.message === "workflow not found" ? 404 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
