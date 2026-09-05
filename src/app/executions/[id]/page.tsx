"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, GitBranch, Gauge, Play, Radio, RotateCcw, Square, Wrench } from "lucide-react";

import { WorkflowGraph, toGraphNodes, type ApiWorkflowNode, type NodeStatus } from "@/components/workflow-graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { takenLinks, type RoutingLink } from "@/workflows/routing";
import type { WorkflowEvent } from "@/events/types";
import { stepFailure } from "@/executions/failure";
import { formatPoints, quotaShare } from "@/executions/quota";
import type { ExecutionRecord, ExecutionStepRecord } from "@/executions/types";

interface Detail {
  execution: ExecutionRecord;
  steps: ExecutionStepRecord[];
  workflow: { id: string; name: string; entry: string; nodes: ApiWorkflowNode[] } | null;
  resumedAs: string[];
}

const STATUS_VARIANT: Record<ExecutionRecord["status"], "default" | "success" | "destructive"> = {
  running: "default",
  completed: "success",
  failed: "destructive",
};

// Test runners colour their output; the escape codes make a failing suite
// unreadable here, and reading it is the whole point of opening the step.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function preview(value: unknown): string {
  if (value == null) return "—";
  const s = (typeof value === "string" ? value : JSON.stringify(value, null, 2)).replace(ANSI, "");
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

export default function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [starting, setStarting] = useState<"restart" | "continue" | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, NodeStatus>>({});
  const [liveEdges, setLiveEdges] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [stopping, setStopping] = useState(false);
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

  // Restart begins the same workflow fresh (a new worktree from HEAD); Continue
  // reuses this run's worktree and picks up at the node it stopped on. Both
  // just ask the server which node id to go look at next.
  async function restart() {
    if (!detail?.execution) return;
    setStarting("restart");
    setStartError(null);
    const r = await fetch("/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: detail.execution.workflowId, input: detail.execution.input }),
    });
    const data = await r.json();
    setStarting(null);
    if (!r.ok) {
      setStartError(data.error ?? "could not restart");
      return;
    }
    router.push(`/executions/${data.executionId}`);
  }

  async function continueRun() {
    setStarting("continue");
    setStartError(null);
    const r = await fetch(`/api/executions/${id}/resume`, { method: "POST" });
    const data = await r.json();
    setStarting(null);
    if (!r.ok) {
      setStartError(data.error ?? "could not continue");
      return;
    }
    router.push(`/executions/${data.executionId}`);
  }

  // Asking is all this does: the engine stops at its next check and settles the
  // run itself, so the page keeps streaming until the status actually changes.
  async function stop() {
    setStopping(true);
    try {
      await fetch(`/api/executions/${id}/cancel`, { method: "POST" });
    } finally {
      setStopping(false);
    }
    await load();
  }

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

  /**
   * What the engine chose after each step. Derived from the definition and the
   * order the nodes ran in, so a replay shows the same path the run took —
   * including the fan-out of a parallel node, whose branches interleave.
   */
  const routes: RoutingLink[][] = useMemo(() => {
    if (!detail?.workflow) return [];
    const run = detail.execution;
    // Only a run that ended at a terminal can name its last decision; one that
    // died on an engine error never got to make it.
    const endedWith = replay === null && !run.error && run.status !== "running" ? run.status : undefined;
    return takenLinks(
      detail.workflow.nodes,
      shown.map((s) => s.nodeId),
      endedWith,
    );
  }, [detail, shown, replay]);

  const activeEdges = useMemo(() => {
    if (replay !== null) return new Set(routes.flat().map((l) => `${l.from}->${l.to}`));
    return new Set(liveEdges);
  }, [routes, liveEdges, replay]);

  const graphNodes = useMemo(() => (detail?.workflow ? toGraphNodes(detail.workflow.nodes) : []), [detail]);
  const ex = detail?.execution;

  return (
    <main className="mx-auto max-w-[1500px] space-y-4 px-6 py-8">
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
            {ex?.resumedFrom && (
              <p className="text-[11px] text-muted-foreground">
                resumed from{" "}
                <Link href={`/executions/${ex.resumedFrom}`} className="font-mono underline-offset-4 hover:underline">
                  {ex.resumedFrom.slice(0, 8)}
                </Link>
              </p>
            )}
            {detail && detail.resumedAs.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                continued as{" "}
                {detail.resumedAs.map((childId, i) => (
                  <span key={childId}>
                    {i > 0 && ", "}
                    <Link href={`/executions/${childId}`} className="font-mono underline-offset-4 hover:underline">
                      {childId.slice(0, 8)}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Radio className={connected ? "size-3.5 text-emerald-500" : "size-3.5"} />
              {connected ? "streaming" : "connecting…"}
            </span>
          )}
          {running && (
            <Button variant="outline" size="sm" onClick={stop} disabled={stopping}>
              <Square /> {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          {ex && !running && (
            <>
              <Button variant="outline" size="sm" onClick={restart} disabled={starting !== null}>
                <RotateCcw /> {starting === "restart" ? "Starting…" : "Restart"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={continueRun}
                disabled={starting !== null}
                title="Continues in the same worktree, at the node this run stopped on"
              >
                <Play /> {starting === "continue" ? "Starting…" : "Continue"}
              </Button>
            </>
          )}
          {ex && (
            <Badge variant={STATUS_VARIANT[ex.status]} className="text-[10px]">
              {ex.status}
            </Badge>
          )}
        </div>
      </header>

      {startError && <p className="text-sm text-destructive">{startError}</p>}

      {ex?.error && <WhyItStopped error={ex.error} steps={steps} />}

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

      {ex?.quota && <QuotaCard quota={ex.quota} />}

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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2.3fr)_minmax(320px,1fr)]">
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

        <Card className="max-h-[min(72vh,720px)] space-y-1 overflow-y-auto p-3">
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
              {routes[s.stepIndex]?.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-1.5 border-t px-2 py-1 text-[10px] text-muted-foreground">
                  <span>→</span>
                  {routes[s.stepIndex].map((l, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span className="font-mono text-foreground/80">{l.to}</span>
                      {l.kind === "branch" && <span>in parallel</span>}
                      {l.kind === "join" && <span>after the branches</span>}
                      {l.label && <span>· {l.label}</span>}
                      {!l.label && l.when && <span className="font-mono">· {l.when}</span>}
                      {i < routes[s.stepIndex].length - 1 && <span>,</span>}
                    </span>
                  ))}
                </div>
              )}
              {(() => {
                const failure = stepFailure(s.output);
                if (!failure) return null;
                return (
                  <div className="border-t bg-destructive/5 px-2 py-1">
                    <div className="text-[10px] uppercase tracking-wide text-destructive">{failure.headline}</div>
                    {failure.lines.map((l, i) => (
                      <div key={i} className="truncate font-mono text-[10px] text-muted-foreground" title={l}>
                        {l}
                      </div>
                    ))}
                  </div>
                );
              })()}
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


function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * What this run alone consumed. The token and cost figures are its own steps
 * summed; the window shares are attributed by cost, which is an estimate and
 * says so — the API never reports what a single run moved a window by.
 */
function QuotaCard({ quota }: { quota: NonNullable<ExecutionRecord["quota"]> }) {
  const share = quotaShare(quota);
  const { input, output, cacheRead } = quota.tokens;
  const total = input + output + cacheRead;
  if (total === 0) return null;

  return (
    <Card className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Gauge className="size-3.5 text-muted-foreground" />
        <span className="font-medium">This run used</span>
        <span className="font-mono">{fmtTokens(total)} tokens</span>
        <span className="text-muted-foreground">
          {fmtTokens(input)} in · {fmtTokens(output)} out
          {cacheRead > 0 && ` · ${fmtTokens(cacheRead)} cached`}
        </span>
        <span className="ml-auto font-mono">${quota.costUsd.toFixed(3)}</span>
      </div>

      {share && (share.fiveHour != null || share.weekly != null) && (
        <div className="space-y-0.5 border-t pt-2">
          {share.fiveHour != null && (
            <WindowLine label="5-hour window" points={share.fiveHour} atPct={share.at5hPct} />
          )}
          {share.weekly != null && <WindowLine label="Weekly window" points={share.weekly} atPct={share.at7dPct} />}
          <p className="pt-1 text-[10px] text-muted-foreground">
            Estimated: the API reports where a window stands, never what one run moved it by, so this run&apos;s slice
            is its share of the cost of everything the gateway sent inside that window.
          </p>
        </div>
      )}
    </Card>
  );
}

function WindowLine({ label, points, atPct }: { label: string; points: number; atPct: number | null }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 text-muted-foreground">{label}</span>
      <span className="font-mono">≈ {formatPoints(points)}</span>
      {atPct != null && <span className="text-muted-foreground">· window now at {atPct.toFixed(1)}%</span>}
    </div>
  );
}


/**
 * The end of the run, said in one place.
 *
 * A halt code on its own ("ran 6 times") tells you a node repeated, not what
 * refused it. The step that did the refusing is in the history, so its reason
 * is lifted up here — a gate that was already red before the run started reads
 * as exactly that, instead of looking like the agent's fault.
 */
function WhyItStopped({
  error,
  steps,
}: {
  error: NonNullable<ExecutionRecord["error"]>;
  steps: ExecutionStepRecord[];
}) {
  // The last step that refused is the one that ended the run.
  let culprit: { step: ExecutionStepRecord; failure: NonNullable<ReturnType<typeof stepFailure>> } | null = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const failure = stepFailure(steps[i].output, 6);
    if (failure) {
      culprit = { step: steps[i], failure };
      break;
    }
  }
  const sameNode = culprit ? steps.filter((s) => s.nodeId === culprit!.step.nodeId) : [];
  const attempts = sameNode.length;
  const refusals = sameNode.filter((s) => stepFailure(s.output)).length;

  return (
    <Card className="space-y-2 border-destructive/50 p-3 text-sm">
      <div className="text-destructive">
        <span className="font-mono text-xs">{error.code}</span> — {error.message}
      </div>
      {culprit && (
        <div className="space-y-1 border-t pt-2">
          <div className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{culprit.step.nodeId}</span> refused with{" "}
            <span className="font-mono">{culprit.failure.headline}</span>
            {attempts > 1 && (
              <>
                {" "}
                · refused {refusals} of {attempts} attempts
              </>
            )}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]">
            {culprit.failure.lines.join("\n") || "the output said nothing more"}
          </pre>
          {attempts > 1 && refusals === attempts && (
            <p className="text-[11px] text-muted-foreground">
              It refused every attempt, so it was already failing before this run touched anything.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
