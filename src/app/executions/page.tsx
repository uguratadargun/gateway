"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectHandle, SelectionBar, deleteMany, rowClass, useSelection } from "@/components/bulk-select";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selection = useSelection(executions.map((e) => e.id));

  async function load() {
    const r = await fetch("/api/executions");
    setExecutions((await r.json()).executions);
  }
  useEffect(() => {
    load();
  }, []);

  async function removeSelected() {
    const ids = [...selection.selected];
    if (!ids.length) return;
    // The worktrees are the deliverable, so they outlive the record on purpose:
    // deleting history here must not be read as cleaning up branches.
    const withTree = executions.filter((e) => ids.includes(e.id) && e.workspace).length;
    const many = ids.length > 1;
    if (
      !confirm(
        `Delete ${ids.length} run${many ? "s" : ""} from the history?` +
          (withTree > 0
            ? `\n\n${withTree} of them produced a git worktree. Those are left on disk — remove them with \`git worktree remove\`.`
            : ""),
      )
    ) {
      return;
    }
    setBusy(true);
    const failed = await deleteMany((id) => `/api/executions/${id}`, ids);
    setBusy(false);
    setError(failed.length ? `could not delete ${failed.length} of them` : null);
    selection.clear();
    await load();
  }

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
      {error && <p className="text-sm text-destructive">{error}</p>}

      {executions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet — start one from a workflow.</p>
      ) : (
        <div className="space-y-2">
          {executions.map((e) => (
            <Card key={e.id} className={rowClass(selection.selected.has(e.id))}>
              <SelectHandle
                checked={selection.selected.has(e.id)}
                active={selection.active}
                onChange={() => selection.toggle(e.id)}
                label={`Select run ${e.id.slice(0, 8)}`}
              />
              <Link href={`/executions/${e.id}`} className="flex min-w-0 flex-1 items-center gap-3">
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
              </Link>
            </Card>
          ))}
          <SelectionBar selection={selection} total={executions.length} noun="runs" onDelete={removeSelected} busy={busy} />
        </div>
      )}
    </main>
  );
}
