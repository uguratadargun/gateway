"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface SessionSummary {
  id: string;
  title: string | null;
  firstTs: number;
  lastTs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  models: string[];
}

interface UsageEvent {
  ts: number;
  model: string;
  tier: string;
  reason: string;
  status: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, UsageEvent[]>>({});

  async function load() {
    const r = await fetch("/api/sessions");
    setSessions((await r.json()).sessions);
  }
  useEffect(() => {
    load();
  }, []);

  async function toggle(id: string) {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    if (!events[id]) {
      const r = await fetch(`/api/sessions/${id}`);
      const data = await r.json();
      setEvents((prev) => ({ ...prev, [id]: data.events }));
    }
  }

  const totalCost = sessions.reduce((s, x) => s + x.cost, 0);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Requests grouped by conversation — which session used your quota. {sessions.length} sessions · ${totalCost.toFixed(2)} est.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
          <RefreshCw />
        </Button>
      </header>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Card key={s.id} className="overflow-hidden">
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40" onClick={() => toggle(s.id)}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.title ?? <span className="text-muted-foreground">(untitled)</span>}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{new Date(s.lastTs).toLocaleString()}</span>
                    <span>·</span>
                    <span>{s.requests} req</span>
                    <span>·</span>
                    <span>
                      {fmtTokens(s.inputTokens)} in / {fmtTokens(s.outputTokens)} out
                      {s.cacheReadTokens > 0 && ` · ${fmtTokens(s.cacheReadTokens)} cached`}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {s.models.map((m) => (
                    <Badge key={m} variant="secondary" className="font-mono text-[10px]">
                      {m.replace("claude-", "")}
                    </Badge>
                  ))}
                  <span className="w-16 text-right font-medium tabular-nums">${s.cost.toFixed(3)}</span>
                </div>
              </button>
              {open === s.id && (
                <CardContent className="border-t bg-muted/20 pt-3">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="pb-1 font-medium">Time</th>
                        <th className="pb-1 font-medium">Tier</th>
                        <th className="pb-1 font-medium">Tokens</th>
                        <th className="pb-1 font-medium">Cached</th>
                        <th className="pb-1 font-medium">Reason</th>
                        <th className="pb-1 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {(events[s.id] ?? []).map((e, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-1 pr-2">{new Date(e.ts).toLocaleTimeString()}</td>
                          <td className="py-1 pr-2">{e.tier}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{fmtTokens(e.inputTokens ?? 0)}/{fmtTokens(e.outputTokens ?? 0)}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{e.cacheReadTokens ? fmtTokens(e.cacheReadTokens) : "—"}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{e.reason}</td>
                          <td className="py-1">
                            <span className={e.status < 300 ? "text-emerald-500" : "text-destructive"}>{e.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
