"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MessageSquareWarning } from "lucide-react";

import { TeamPicker, useTeamScope, withTeam } from "@/components/team-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DecisionIssue } from "@/memory/issues";
import type { ChangeTask, TaskStatus } from "@/orchestration/tasks";

/**
 * The work, named, with everything still unsettled under it.
 *
 * A task is a label and nothing more: it does not find the runs or the
 * objections, it only groups the ones that named it. That is why this page
 * leans on the objections rather than the runs — a task is worth opening when
 * something under it is still waiting on another team, and worth closing when
 * a person says so. No run ending closes it.
 */

const TASK_VARIANT: Record<TaskStatus, "default" | "secondary" | "outline"> = {
  open: "default",
  done: "secondary",
  abandoned: "outline",
};

const RUN_VARIANT: Record<string, "default" | "secondary" | "destructive" | "success" | "outline"> = {
  running: "default",
  completed: "success",
  failed: "destructive",
  cancelled: "secondary",
};

function issueVariant(status: string): "destructive" | "success" | "secondary" {
  if (status === "open") return "destructive";
  if (status === "resolved") return "success";
  return "secondary";
}

interface TaskDetail {
  task: ChangeTask;
  executions: Array<{ id: string; teamId: string; status: string; startedAt: number }>;
  issues: DecisionIssue[];
}

export default function TasksPage() {
  const { team, setTeam, teams, ready } = useTeamScope();
  const [tasks, setTasks] = useState<ChangeTask[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(withTeam(`/api/tasks${showClosed ? "?all=1" : ""}`, team));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "could not read tasks");
    setTasks(data.tasks);
  }, [team, showClosed]);

  useEffect(() => {
    if (ready) void load().catch((e) => setError((e as Error).message));
  }, [ready, load]);

  // Switching team can put the open task out of the family that may see it.
  useEffect(() => setDetail(null), [team]);

  async function open(id: string) {
    setError(null);
    try {
      const r = await fetch(withTeam(`/api/tasks?id=${encodeURIComponent(id)}`, team));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not read the task");
      setDetail(data);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create() {
    const name = title.trim();
    if (!name) return;
    setError(null);
    try {
      const r = await fetch(withTeam("/api/tasks", team), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not open the task");
      setTitle("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setStatus(id: string, status: TaskStatus, open_: number) {
    // Closing a task does not withdraw what was raised under it, and saying so
    // is the point: an objection outlives the name the work was filed under.
    if (
      status !== "open" &&
      open_ > 0 &&
      !confirm(
        `${open_} objection${open_ === 1 ? "" : "s"} under this task ${open_ === 1 ? "is" : "are"} still unanswered.\n\n` +
          `Closing the task leaves ${open_ === 1 ? "it" : "them"} standing — the other team still sees ${open_ === 1 ? "it" : "them"}. Close anyway?`,
      )
    )
      return;
    setError(null);
    try {
      const r = await fetch(withTeam("/api/tasks", team), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not change the task");
      await load();
      if (detail?.task.id === id) await open(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const live = detail?.issues.filter((i) => i.status === "proposed" || i.status === "open") ?? [];

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Work that outlives the runs serving it — and the objections still standing under it.
          </p>
        </div>
        <TeamPicker team={team} teams={teams} onChange={setTeam} />
      </header>

      <Card className="flex items-center gap-2 p-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="What is the work? e.g. post-quantum handshake"
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={() => void create()} disabled={!title.trim()}>
          Open task
        </Button>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {showClosed ? "All tasks" : "Open tasks"}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? "Only open" : "Show closed"}
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks yet — open one here, then start a run with <code className="font-mono text-xs">--task-id</code> to file it
          under this work.
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <Card key={t.id} className="group flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40">
              <button type="button" onClick={() => void open(t.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t.teamId}</span>
                    <span>·</span>
                    <span>opened {new Date(t.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={TASK_VARIANT[t.status]} className="text-[10px]">
                  {t.status}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      {detail ? (
        <Card className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{detail.task.title}</div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{detail.task.id}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {detail.task.status === "open" ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => void setStatus(detail.task.id, "done", live.length)}>
                    Done
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void setStatus(detail.task.id, "abandoned", live.length)}>
                    Abandon
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void setStatus(detail.task.id, "open", 0)}>
                  Reopen
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                Close
              </Button>
            </div>
          </div>

          <div className="space-y-1 border-t pt-2">
            <div className="flex items-center gap-2 px-1">
              <MessageSquareWarning className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cross-team objections</span>
            </div>
            {detail.issues.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">
                Nothing raised under this task. Objections are found by the paths and features they touch, so a run that named no
                task can still have raised one elsewhere.
              </p>
            ) : (
              detail.issues.map((i) => (
                <div key={i.id} className="space-y-1 rounded-md border px-2 py-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={issueVariant(i.status)} className="text-[10px]">
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
                  {i.resolution ? (
                    <p className="text-muted-foreground">
                      {i.resolvedBy ?? "settled"}: {i.resolution}
                    </p>
                  ) : i.status === "proposed" ? (
                    <p className="text-muted-foreground">raised — nobody has answered it yet</p>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="space-y-1 border-t pt-2">
            <span className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Runs</span>
            {detail.executions.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">
                No run has named this task yet — pass <code className="font-mono">--task-id {detail.task.id}</code> to file one
                under it.
              </p>
            ) : (
              detail.executions.map((e) => (
                <Link
                  key={e.id}
                  href={`/executions/${e.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/40"
                >
                  <Badge variant={RUN_VARIANT[e.status] ?? "secondary"} className="text-[10px]">
                    {e.status}
                  </Badge>
                  <span className="text-muted-foreground">{e.teamId}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{new Date(e.startedAt).toLocaleString()}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{e.id.slice(0, 8)}</span>
                </Link>
              ))
            )}
          </div>
        </Card>
      ) : null}
    </main>
  );
}
