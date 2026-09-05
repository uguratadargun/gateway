"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ExecutionRecord } from "@/executions/types";

const STATUS_VARIANT: Record<ExecutionRecord["status"], "default" | "success" | "destructive"> = {
  running: "default",
  completed: "success",
  failed: "destructive",
};

function duration(e: { startedAt: number; finishedAt: number | null }): string {
  if (!e.finishedAt) return "running";
  const ms = e.finishedAt - e.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default function ExecutionsPage() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);

  async function load() {
    const r = await fetch("/api/executions");
    setExecutions((await r.json()).executions);
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Executions</h1>
          <p className="text-sm text-muted-foreground">
            Every workflow run, with the exact path it took. {executions.length} runs.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
          <RefreshCw />
        </Button>
      </header>

      {executions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet — start one from a workflow.</p>
      ) : (
        <div className="space-y-2">
          {executions.map((e) => (
            <Link key={e.id} href={`/executions/${e.id}`}>
              <Card className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.workflowId}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{new Date(e.startedAt).toLocaleString()}</span>
                    <span>·</span>
                    <span>{e.stepCount} steps</span>
                    <span>·</span>
                    <span>{duration(e)}</span>
                    {e.error && <span className="text-destructive">{e.error.code}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{e.id.slice(0, 8)}</span>
                  <Badge variant={STATUS_VARIANT[e.status]} className="text-[10px]">
                    {e.status}
                  </Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
