import { NextResponse } from "next/server";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { getIssue, heldAnswerCount, liveIssues, resolveIssue, withdrawIssue } from "@/memory/issues";
import { memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

/**
 * Everything still unsettled for this team, both ways round.
 *
 * Recall shows an objection to the planner that happens to touch the same
 * paths, which is the right moment for a run and the wrong one for a person:
 * a team that does not plan in those files for a month never learns anybody
 * objected. This is the list a person opens instead — the same rows, found by
 * the team rather than by the code.
 */
export async function GET(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const team = scope.teamId!;
  // No paths and no feature: everything live in this team's family, which is
  // the same boundary recall uses. The sides are split here rather than in the
  // query because one row can only be on one of them.
  const issues = liveIssues(memoryScopeFor(team), { limit: 100 });
  return NextResponse.json({
    team,
    against: issues.filter((i) => i.targetTeamId === team),
    raised: issues.filter((i) => i.fromTeamId === team),
    // Objections in the family this team is on neither side of. Worth seeing —
    // a parent watching two of its teams disagree is the case this serves —
    // and not actionable from here.
    elsewhere: issues.filter((i) => i.targetTeamId !== team && i.fromTeamId !== team),
    heldAnswers: heldAnswerCount(memoryScopeFor(team)),
  });
}

/**
 * Closing an objection — the one surface that does it, and a person's.
 *
 * The two closings are two different facts and belong to different teams: the
 * team objected to says the request was met, the team that raised it says it
 * was wrong to raise. Neither may do the other's, and no run does either.
 */
export async function PATCH(req: Request) {
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const team = scope.teamId!;
  const body = (await req.json().catch(() => null)) as { id?: unknown; action?: unknown; note?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const action = body?.action;
  if (!id || (action !== "resolve" && action !== "withdraw")) {
    return NextResponse.json({ error: "id and an action of resolve or withdraw are required" }, { status: 400 });
  }

  // An objection this team is on neither side of is not refused with a reason
  // that admits it exists: from here it simply is not an objection.
  const issue = getIssue(id);
  if (!issue || (issue.targetTeamId !== team && issue.fromTeamId !== team)) {
    return NextResponse.json({ error: "no such objection" }, { status: 404 });
  }

  if (action === "resolve") {
    if (issue.targetTeamId !== team) {
      return NextResponse.json(
        { error: "only the team whose decision was objected to can resolve it", code: "NOT_THE_TARGET" },
        { status: 403 },
      );
    }
    // The note has a reader: the objecting team's next recall shows it. An
    // empty one tells them the row moved and nothing else.
    const note = typeof body?.note === "string" ? body.note.trim() : "";
    if (!note) return NextResponse.json({ error: "say what was done about it", code: "NOTE_REQUIRED" }, { status: 400 });
    if (!resolveIssue(id, team, note)) {
      return NextResponse.json({ error: "this objection is already settled", code: "SETTLED" }, { status: 409 });
    }
  } else {
    if (issue.fromTeamId !== team) {
      return NextResponse.json(
        { error: "only the team that raised it can withdraw it", code: "NOT_THE_SOURCE" },
        { status: 403 },
      );
    }
    if (!withdrawIssue(id)) {
      return NextResponse.json({ error: "this objection is already settled", code: "SETTLED" }, { status: 409 });
    }
  }

  return NextResponse.json(getIssue(id));
}
