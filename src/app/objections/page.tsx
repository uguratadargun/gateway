"use client";

import { useCallback, useEffect, useState } from "react";

import { ObjectionCard } from "@/components/objection-card";
import { TeamPicker, useTeamScope, withTeam } from "@/components/team-picker";
import { Card } from "@/components/ui/card";
import type { DecisionIssue } from "@/memory/issues";

/**
 * What is waiting on this team, and what this team is waiting on.
 *
 * Recall already shows an objection to the planner that touches the same
 * paths, which is the right moment for a run and the wrong one for a person: a
 * team that does not plan in those files for a month never learns anybody
 * objected. This page is the other half — the same rows, found by the team
 * rather than by the code, and the only place an objection raised by a run
 * that named no task is visible at all.
 *
 * Against us comes first. It is the list with something owed on it.
 */

interface Board {
  team: string;
  against: DecisionIssue[];
  raised: DecisionIssue[];
  elsewhere: DecisionIssue[];
  heldAnswers: number;
}

const EMPTY: Board = { team: "", against: [], raised: [], elsewhere: [], heldAnswers: 0 };

export default function ObjectionsPage() {
  const { team, setTeam, teams, ready } = useTeamScope();
  const [board, setBoard] = useState<Board>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(withTeam("/api/issues", team));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "could not read the objections");
    setBoard(data);
  }, [team]);

  const reload = useCallback(() => load().catch((e) => setError((e as Error).message)), [load]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  function section(title: string, note: string, issues: DecisionIssue[], empty: string) {
    return (
      <section className="space-y-1">
        <div className="flex items-baseline gap-2 px-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
          {issues.length ? <span className="text-xs text-muted-foreground">{issues.length}</span> : null}
        </div>
        <p className="px-1 text-xs text-muted-foreground">{note}</p>
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="space-y-2">
            {issues.map((i) => (
              <ObjectionCard key={i.id} issue={i} team={team} onSettled={reload} onError={setError} />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Objections</h1>
          <p className="text-sm text-muted-foreground">
            Where one team cannot live with another&apos;s decision. Closed by the side it belongs to, never by a run.
          </p>
        </div>
        <TeamPicker team={team} teams={teams} onChange={setTeam} />
      </header>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {/*
       * An answer that never reached the server is the worst failure this
       * feature has: somebody decided, and the decision went nowhere visible.
       * The planner is told the count; so is the person.
       */}
      {board.heldAnswers > 0 ? (
        <Card className="p-3 text-xs text-muted-foreground">
          {board.heldAnswers} answer{board.heldAnswers === 1 ? "" : "s"} to objections never reached the server and{" "}
          {board.heldAnswers === 1 ? "is" : "are"} not shown below. An empty list is not proof nobody objected.
        </Card>
      ) : null}

      {section(
        "Against this team",
        "Another team cannot live with a decision of ours. Resolve one when the work is done, saying what was done — they read that next time they plan.",
        board.against,
        "Nothing is standing against this team.",
      )}

      {section(
        "Raised by this team",
        "We objected and are waiting. Withdraw one we were wrong to raise; only the other team can resolve it.",
        board.raised,
        "This team has nothing outstanding against anybody.",
      )}

      {board.elsewhere.length ? (
        section(
          "Elsewhere in the family",
          "Two other teams in this tree disagreeing. Visible here, settled by them.",
          board.elsewhere,
          "",
        )
      ) : null}
    </main>
  );
}
