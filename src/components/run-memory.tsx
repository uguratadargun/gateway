"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, RefreshCw } from "lucide-react";

import { DecisionView } from "@/components/decision-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toDecisionCard } from "@/memory/cards";
import type { Decision, Extraction, Feature } from "@/memory/types";

interface RunMemoryData {
  extraction: Extraction | null;
  decisions: Decision[];
  feature: Feature | null;
}

/**
 * What the recorder made of a run, on the run's own page: the ledger row
 * — queued, running, done with a count and a cost, or failed with why and a
 * button to try again — and the decisions it wrote.
 */
export function RunMemory({ executionId }: { executionId: string }) {
  const [data, setData] = useState<RunMemoryData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/executions/${executionId}/memory`);
    if (r.ok) setData(await r.json());
  }, [executionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A pending or running extraction settles within a minute of the run; poll
  // until it has, so the page does not show "queued" after the work is done.
  const settling = data?.extraction && (data.extraction.status === "pending" || data.extraction.status === "running");
  useEffect(() => {
    if (!settling) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [settling, load]);

  async function retry() {
    setBusy(true);
    try {
      const r = await fetch(`/api/executions/${executionId}/memory`, { method: "POST" });
      if (r.ok) setData(await r.json());
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const e = data.extraction;
  const status = e?.status ?? "not queued";
  const variant = status === "done" ? "success" : status === "failed" ? "destructive" : "secondary";
  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Memory</span>
        <Badge variant={variant}>{status}</Badge>
        {e?.status === "done" && (
          <span className="text-xs text-muted-foreground">
            {e.decisionCount} decision{e.decisionCount === 1 ? "" : "s"}
            {e.model && ` · ${e.model}`}
            {e.costUsd != null && ` · $${e.costUsd.toFixed(4)}`}
            {e.attempts > 1 && ` · attempt ${e.attempts}`}
          </span>
        )}
        {e?.status === "skipped" && <span className="text-xs text-muted-foreground">{e.error}</span>}
        {e?.status === "failed" && (
          <span className="text-xs text-destructive">
            {e.error} · attempt {e.attempts}
          </span>
        )}
        {e?.status === "pending" && <span className="text-xs text-muted-foreground">waiting for the recorder</span>}
        {e?.status === "running" && <span className="text-xs text-muted-foreground">the recorder is reading the run…</span>}
        {e && e.status !== "running" && e.status !== "pending" && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void retry()} disabled={busy}>
            <RefreshCw className={busy ? "animate-spin" : ""} /> Record again
          </Button>
        )}
      </div>
      {data.feature && (
        <p className="px-1 text-xs text-muted-foreground">
          Filed under <span className="font-medium text-foreground">{data.feature.name}</span> <code>{data.feature.id}</code>
        </p>
      )}
      {data.decisions.map((d) => (
        <DecisionView key={d.id} decision={toDecisionCard(d)} />
      ))}
    </Card>
  );
}
