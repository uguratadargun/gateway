"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DecisionCard } from "@/memory/cards";
import { SHIPPED_OUTCOMES } from "@/memory/types";

/**
 * One decision as a person reads it: the record, its provenance, what it
 * touched. Read-only unless the page passes `onForget` — so the button to
 * delete a record appears only where somebody may.
 */
export function DecisionView({ decision: d, onForget }: { decision: DecisionCard; onForget?: () => void }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{d.title}</span>
        <Badge variant="secondary">{d.team}</Badge>
        {d.author && d.author !== d.team && <span className="text-xs text-muted-foreground">made by {d.author}</span>}
        {/* An unfinished run is not a refusal: only the verdict is shown in red. */}
        <Badge variant={SHIPPED_OUTCOMES.includes(d.outcome) ? "success" : "secondary"} title={d.outcome === "abandoned" ? "The run did not finish. That is not a verdict on the idea." : undefined}>
          {d.outcome}
        </Badge>
        {d.verdict === "rejected" && (
          <Badge variant="destructive" title={d.verdictReason ?? "The approach was refused."}>
            refused
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {d.validFrom.slice(0, 10)}
          {d.validTo ? ` → ${d.validTo.slice(0, 10)} (no longer holds)` : ""}
        </span>
        <Link href={`/executions/${d.executionId}`} className="ml-auto font-mono text-xs text-muted-foreground hover:underline">
          run {d.executionId.slice(0, 8)}
        </Link>
        {onForget && (
          <Button
            variant="ghost"
            size="sm"
            className="size-6 p-0 text-muted-foreground hover:text-destructive"
            title="Forget this decision: the record and everything that pointed at it."
            onClick={() => {
              if (confirm(`Forget "${d.title}"?\n\nThe decision is deleted from memory — searches, paths and the feature's count. The run it came from stays. This cannot be undone.`)) onForget();
            }}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {d.verdict === "rejected" && d.verdictReason && <p className="mt-2 whitespace-pre-wrap text-destructive">Refused: {d.verdictReason}</p>}
      {d.checked?.allGone && (
        <p className="mt-2 text-amber-700 dark:text-amber-400">
          Every file it touched is gone from the base branch at <code>{d.checked.commit.slice(0, 8)}</code> — it describes code that no longer exists.
        </p>
      )}
      {d.decision && <p className="mt-2 whitespace-pre-wrap">{d.decision}</p>}
      {d.rationale && (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium text-foreground">Why: </span>
          {d.rationale}
        </p>
      )}
      {d.how && (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium text-foreground">How: </span>
          {d.how}
        </p>
      )}
      {d.alternatives && (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium text-foreground">Not taken: </span>
          {d.alternatives}
        </p>
      )}
      {d.consequences && (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium text-foreground">Consequences: </span>
          {d.consequences}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>{d.id}</span>
        {d.repo && <span>{d.repo}</span>}
        {d.featureId && <span>feature {d.featureId}</span>}
        {d.supersedes && <span>supersedes {d.supersedes}</span>}
        {(d.commits.base || d.commits.head) && (
          <span>
            {d.commits.base?.slice(0, 8) ?? "?"}..{d.commits.head?.slice(0, 8) ?? "?"}
          </span>
        )}
      </div>
      {d.touches.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.touches.slice(0, 20).map((t) => (
            <code key={t} className="rounded bg-muted px-1 text-[10px]">
              {t}
            </code>
          ))}
          {d.touches.length > 20 && <span className="text-[10px] text-muted-foreground">+{d.touches.length - 20}</span>}
        </div>
      )}
    </div>
  );
}
