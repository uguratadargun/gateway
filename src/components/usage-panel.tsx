"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface UsageEvent {
  ts: number;
  requested: string;
  model: string;
  tier: string;
  reason: string;
  status: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface Usage {
  total: number;
  byTier: Record<string, number>;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costAllOpus: number;
  savings: number;
  recent: UsageEvent[];
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function UsagePanel() {
  const [usage, setUsage] = useState<Usage | null>(null);

  async function refresh() {
    const res = await fetch("/api/usage");
    setUsage(await res.json());
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Usage</CardTitle>
          <CardDescription>{usage?.total ?? 0} requests routed through gate.</CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh">
          <RefreshCw />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Requests" value={String(usage?.total ?? 0)} />
          <Stat
            label="Tokens"
            value={fmtTokens((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))}
            hint={`${fmtTokens(usage?.inputTokens ?? 0)} in · ${fmtTokens(usage?.outputTokens ?? 0)} out`}
          />
          <Stat
            label="Est. cost"
            value={fmtUsd(usage?.cost ?? 0)}
            hint="API-equivalent"
          />
          <Stat
            label="Saved vs Opus"
            value={fmtUsd(usage?.savings ?? 0)}
            hint={
              usage && usage.costAllOpus > 0
                ? `${Math.round((usage.savings / usage.costAllOpus) * 100)}% cheaper`
                : "from routing"
            }
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {usage &&
            Object.entries(usage.byTier).map(([tier, count]) => (
              <Badge key={tier} variant="secondary">
                {tier}: {count}
              </Badge>
            ))}
          {usage && usage.total === 0 && (
            <p className="text-sm text-muted-foreground">
              No requests yet — send one through the gateway to see usage.
            </p>
          )}
        </div>
        {usage && usage.recent.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Requested</th>
                  <th className="pb-2 font-medium">Routed</th>
                  <th className="pb-2 font-medium">Tokens</th>
                  <th className="pb-2 font-medium">Reason</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {usage.recent.slice(0, 12).map((e, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 pr-2">{new Date(e.ts).toLocaleTimeString()}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{e.requested}</td>
                    <td className="py-1.5 pr-2">{e.tier}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">
                      {(e.inputTokens ?? 0) + (e.outputTokens ?? 0) > 0
                        ? `${fmtTokens(e.inputTokens ?? 0)}/${fmtTokens(e.outputTokens ?? 0)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{e.reason}</td>
                    <td className="py-1.5">
                      <span className={e.status < 300 ? "text-emerald-500" : "text-destructive"}>
                        {e.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
