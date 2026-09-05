"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, GitBranch, Radio, Wrench } from "lucide-react";

import { WorkflowGraph, toGraphNodes, type ApiWorkflowNode, type NodeStatus } from "@/components/workflow-graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { WorkflowEvent } from "@/events/types";
import type { ExecutionRecord, ExecutionStepRecord } from "@/executions/types";

interface Detail {
  execution: ExecutionRecord;
  steps: ExecutionStepRecord[];
  workflow: { id: string; name: string; entry: string; nodes: ApiWorkflowNode[] } | null;
}

const STATUS_VARIANT: Record<ExecutionRecord["status"], "default" | "success" | "destructive"> = {
  running: "default",
  completed: "success",
  failed: "destructive",
};

function preview(value: unknown): string {
  if (value == null) return "—";
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

export default function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [live, setLive] = useState<Record<string, NodeStatus>>({});
  const [liveEdges, setLiveEdges] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [liveTools, setLiveTools] = useState<Array<{ nodeId: string; tool: string; ok: boolean; summary: string }>>([]);
  const [openStep, setOpenStep] = useState<number | null>(null);
  /** Replay position for a finished run; null = show the whole run. */
  const [replay, setReplay] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/executions/${id}`);
    if (r.ok) setDetail(await r.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const running = detail?.execution.status === "running";

  useEffect(() => {
    if (!running) return;
    const es = new EventSource(`/api/executions/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let e: WorkflowEvent;
      try {
        e = JSON.parse(m.data) as WorkflowEvent;
      } catch {
        return;
      }
      if (e.type === "node.started") setLive((p) => ({ ...p, [e.nodeId]: "running" }));
      if (e.type === "node.completed") {
        setLive((p) => ({ ...p, [e.nodeId]: "completed" }));
        load();
      }
      if (e.type === "node.failed") {
        setLive((p) => ({ ...p, [e.nodeId]: "failed" }));
        load();
      }
      if (e.type === "tool.called") {
        setLiveTools((p) => [...p, { nodeId: e.nodeId, tool: e.tool, ok: e.ok, summary: e.summary }].slice(-12));
      }
      if (e.type === "edge.selected") setLiveEdges((p) => [...p, `${e.from}->${e.to}`].slice(-20));
      if (e.type === "workflow.completed" || e.type === "workflow.failed") {
        es.close();
        setConnected(false);
        load();
      }
    };
    return () => es.close();
  }, [running, id, load]);

  const steps = detail?.steps ?? [];
  const shown = replay === null ? steps : steps.slice(0, replay + 1);

  const statuses = useMemo(() => {
    const out: Record<string, NodeStatus> = {};
    for (const s of shown) out[s.nodeId] = s.status === "failed" ? "failed" : "completed";
    if (replay === null) for (const [k, v] of Object.entries(live)) out[k] = v;
    return out;
  }, [shown, live, replay]);

  const activeEdges = useMemo(() => {
    if (replay !== null) {
      const set = new Set<string>();
      for (let i = 0; i + 1 < shown.length; i++) set.add(`${shown[i].nodeId}->${shown[i + 1].nodeId}`);
      return set;
    }
    return new Set(liveEdges);
  }, [shown, liveEdges, replay]);

  const graphNodes = useMemo(() => (detail?.workflow ? toGraphNodes(detail.workflow.nodes) : []), [detail]);
  const ex = detail?.execution;

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/executions">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold">
              {ex ? (
                <Link href={`/workflows/${ex.workflowId}`} className="underline-offset-4 hover:underline">
                  {ex.workflowId}
                </Link>
              ) : (
                "…"
              )}
            </h1>
            <p className="font-mono text-xs text-muted-foreground">{id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Radio className={connected ? "size-3.5 text-emerald-500" : "size-3.5"} />
              {connected ? "streaming" : "connecting…"}
            </span>
          )}
          {ex && (
            <Badge variant={STATUS_VARIANT[ex.status]} className="text-[10px]">
              {ex.status}
            </Badge>
          )}
        </div>
      </header>

      {ex?.error && (
        <Card className="border-destructive/50 p-3 text-sm text-destructive">
          <span className="font-mono text-xs">{ex.error.code}</span> — {ex.error.message}
        </Card>
      )}

      {ex?.workspace && (
        <Card className="space-y-1 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="size-3.5 text-muted-foreground" />
            <span className="font-mono font-medium">{ex.workspace.branch}</span>
            <span className="text-muted-foreground">from</span>
            <span className="font-mono text-muted-foreground">{ex.workspace.repo}</span>
            {ex.workspace.changedFiles.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {ex.workspace.changedFiles.length} changed
              </Badge>
            )}
          </div>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{ex.workspace.root}</p>
          {ex.workspace.changedFiles.length > 0 && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
              {ex.workspace.changedFiles.join("\n")}
            </pre>
          )}
        </Card>
      )}

      {running && liveTools.length > 0 && (
        <Card className="space-y-0.5 p-3 text-[11px]">
          <div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tool activity</div>
          {liveTools.map((t, i) => (
            <div key={i} className="flex items-center gap-2 font-mono">
              <Wrench className={t.ok ? "size-3 text-muted-foreground" : "size-3 text-destructive"} />
              <span className="shrink-0 text-muted-foreground">{t.nodeId}</span>
              <span className="shrink-0">{t.tool}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.summary}</span>
            </div>
          ))}
        </Card>
      )}

      {detail && !detail.workflow && (
        <Card className="p-3 text-sm text-muted-foreground">
          The workflow definition changed or was removed since this run; showing the step history only.
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-2">
          {detail?.workflow && (
            <WorkflowGraph nodes={graphNodes} entry={detail.workflow.entry} statuses={statuses} activeEdges={activeEdges} />
          )}
          {!running && steps.length > 0 && (
            <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
              <span className="shrink-0">Replay</span>
              <input
                type="range"
                min={0}
                max={steps.length - 1}
                value={replay ?? steps.length - 1}
                onChange={(e) => setReplay(Number(e.target.value))}
                className="flex-1 accent-foreground"
              />
              <span className="w-28 shrink-0 font-mono">
                {replay === null ? "full run" : `step ${replay + 1}/${steps.length}`}
              </span>
              {replay !== null && (
                <Button variant="ghost" size="sm" onClick={() => setReplay(null)}>
                  reset
                </Button>
              )}
            </div>
          )}
        </div>

        <Card className="max-h-[600px] space-y-1 overflow-y-auto p-3">
          <div className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Steps ({steps.length})
          </div>
          {steps.length === 0 && <p className="px-1 text-xs text-muted-foreground">Waiting for the first step…</p>}
          {steps.map((s) => (
            <div key={s.stepIndex} className="rounded-md border">
              <button
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                onClick={() => setOpenStep(openStep === s.stepIndex ? null : s.stepIndex)}
              >
                <span className="w-5 shrink-0 text-muted-foreground tabular-nums">{s.stepIndex + 1}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{s.nodeId}</span>
                {s.visit > 1 && <span className="shrink-0 text-[10px] text-muted-foreground">×{s.visit}</span>}
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {s.finishedAt - s.startedAt} ms
                </span>
                <span className={s.status === "failed" ? "text-destructive" : "text-emerald-500"}>●</span>
              </button>
              {openStep === s.stepIndex && (
                <div className="space-y-2 border-t bg-muted/20 p-2 text-[11px]">
                  {s.usage && (
                    <div className="font-mono text-muted-foreground">
                      {s.usage.model} · {s.usage.inputTokens} in / {s.usage.outputTokens} out
                      {s.usage.cacheReadTokens > 0 && ` · ${s.usage.cacheReadTokens} cached`}
                    </div>
                  )}
                  {s.error && (
                    <div className="text-destructive">
                      <span className="font-mono">{s.error.code}</span> — {s.error.message}
                    </div>
                  )}
                  {s.toolCalls && s.toolCalls.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        tools ({s.toolCalls.length})
                      </div>
                      <div className="mt-0.5 space-y-1 rounded bg-background p-2 font-mono">
                        {s.toolCalls.map((c, i) => (
                          <div key={i}>
                            <div className="flex items-center gap-1.5">
                              <span className={c.ok ? "text-emerald-500" : "text-destructive"}>●</span>
                              <span>{c.tool}</span>
                              <span className="truncate text-muted-foreground">{preview(c.input).slice(0, 120)}</span>
                              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{c.durationMs} ms</span>
                            </div>
                            <div className="truncate pl-4 text-muted-foreground">{c.result.split("\n")[0].slice(0, 160)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <Section title="input">{preview(s.input)}</Section>
                  <Section title="output">{preview(s.output)}</Section>
                </div>
              )}
            </div>
          ))}
        </Card>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <pre className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono">
        {children}
      </pre>
    </div>
  );
}
