"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Laptop, Play, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectHandle, SelectionBar, deleteMany, rowClass, useSelection } from "@/components/bulk-select";
import { formatDuration, formatElapsed } from "@/lib/duration";
import { type RunDisplayStatus, runElapsed, runStatus } from "@/lib/run-clock";
import type { ExecutionRecord } from "@/executions/types";

const STATUS_VARIANT: Record<RunDisplayStatus, "default" | "secondary" | "success" | "destructive"> = {
  running: "default",
  paused: "secondary",
  completed: "success",
  failed: "destructive",
};

/**
 * How long a run took — and, while it is still going, how long it has taken so
 * far. The word "running" said nothing the status badge beside it did not
 * already say, and hid the one number that tells you whether to go and look.
 * Time spent waiting on the person is left out, and while it is waiting the
 * number stands still.
 */
function duration(e: ExecutionRecord, now: number): string {
  return e.finishedAt ? formatDuration(runElapsed(e, now)) : formatElapsed(runElapsed(e, now));
}

/**
 * What this particular run was asked to do — the same workflow run a dozen
 * times looks identical otherwise, distinguishable only by timestamp or id.
 * "task" is the input every hand-written pipeline actually uses; anything
 * else at least shows something rather than nothing.
 */
function inputPreview(input: Record<string, unknown>): string | null {
  if (typeof input.task === "string" && input.task.trim()) return input.task.trim();
  if (typeof input.repo === "string" && input.repo.trim()) return input.repo.trim();
  const keys = Object.keys(input);
  if (!keys.length) return null;
  const s = JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

export default function ExecutionsPage() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selection = useSelection(executions.map((e) => e.id));
  /** Ticks so a running row's elapsed time moves without a page refresh. */
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    const r = await fetch("/api/executions");
    setExecutions((await r.json()).executions);
  }
  useEffect(() => {
    load();
  }, []);

  const anyRunning = executions.some((e) => !e.finishedAt);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

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
        <div className="flex items-center gap-1">
          <Link href="/executions/new">
            <Button size="sm">
              <Play /> New run
            </Button>
          </Link>
          <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
            <RefreshCw />
          </Button>
        </div>
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
                  {inputPreview(e.input) && (
                    <div className="truncate text-xs text-muted-foreground">{inputPreview(e.input)}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{new Date(e.startedAt).toLocaleString()}</span>
                    <span>·</span>
                    <span>{e.stepCount} steps</span>
                    <span>·</span>
                    <span className="tabular-nums">{duration(e, now)}</span>
                    {/* Where the engine actually was. Two runs of the same
                        workflow are otherwise indistinguishable, and for a
                        local one the machine is where its branch is. */}
                    {e.origin === "local" && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Laptop className="size-3" />
                          {e.client?.host ?? "local"}
                        </span>
                      </>
                    )}
                    {e.error && <span className="text-destructive">{e.error.code}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {e.quota && e.quota.costUsd > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      ${e.quota.costUsd.toFixed(3)}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground">{e.id.slice(0, 8)}</span>
                  <Badge variant={STATUS_VARIANT[runStatus(e)]} className="text-[10px]">
                    {runStatus(e)}
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
