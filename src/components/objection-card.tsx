"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withTeam } from "@/components/team-picker";
import type { DecisionIssue } from "@/memory/issues";

/**
 * One objection, and the two ways it can be closed.
 *
 * Which side the reading team is on decides what it may do: the team objected
 * to resolves, the team that raised it withdraws, and a team on neither side
 * gets no buttons at all — the same rule the endpoint enforces, drawn. The
 * note is asked for only when resolving, because only then does it have a
 * reader: the objecting team's next recall shows it.
 */

function variantOf(status: string): "destructive" | "success" | "secondary" {
  if (status === "open") return "destructive";
  if (status === "resolved") return "success";
  return "secondary";
}

export function ObjectionCard({
  issue: i,
  team,
  onSettled,
  onError,
}: {
  issue: DecisionIssue;
  team: string;
  onSettled: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");

  const live = i.status === "proposed" || i.status === "open";
  const mayResolve = live && i.targetTeamId === team;
  const mayWithdraw = live && i.fromTeamId === team;

  async function settle(action: "resolve" | "withdraw") {
    try {
      const r = await fetch(withTeam("/api/issues", team), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: i.id, action, note: action === "resolve" ? note.trim() : undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not settle the objection");
      setWriting(false);
      setNote("");
      await onSettled();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="space-y-1 rounded-md border px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={variantOf(i.status)} className="text-[10px]">
          {i.status}
        </Badge>
        <span className="font-medium text-foreground">{i.title}</span>
        <span className="text-muted-foreground">
          {i.fromTeamId} → {i.targetTeamId}
        </span>
        <Link href={`/executions/${i.executionId}`} className="ml-auto text-muted-foreground underline-offset-2 hover:underline">
          run
        </Link>
      </div>
      {i.revision ? <p className="text-muted-foreground">asks: {i.revision}</p> : null}
      {i.paths.length ? <p className="font-mono text-[10px] text-muted-foreground">{i.paths.slice(0, 6).join(", ")}</p> : null}
      {i.resolution ? (
        <p className="text-muted-foreground">
          {i.resolvedBy ?? "settled"}: {i.resolution}
        </p>
      ) : i.status === "proposed" ? (
        <p className="text-muted-foreground">raised — nobody has answered it yet</p>
      ) : null}

      {mayResolve || mayWithdraw ? (
        writing ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="what was done about it — the other team reads this"
              className="h-7 flex-1 text-xs"
            />
            <Button size="sm" className="h-7" disabled={!note.trim()} onClick={() => void settle("resolve")}>
              Resolve
            </Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setWriting(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 pt-0.5">
            {mayResolve ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => {
                  setNote("");
                  setWriting(true);
                }}
              >
                Resolve
              </Button>
            ) : null}
            {mayWithdraw ? (
              <Button variant="ghost" size="sm" className="h-7" onClick={() => void settle("withdraw")}>
                Withdraw
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
