"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Database, Gauge, Layers, Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Overview {
  rateLimit: { unifiedStatus: string | null; resetAt: number | null; retryAfter: number | null } | null;
  forecast: {
    utilization: number | null;
    status: string | null;
    resetAt: number | null;
    etaToLimitMs: number | null;
    level: "ok" | "warning" | "critical";
  };
  budget: { enabled: boolean; today: number; month: number; dailyUsd: number; exceeded: boolean };
  cache: { hits: number; misses: number; entries: number; hitRate: number };
  limiter: { inFlight: number; queued: number; max: number; queuedTotal: number; coalescedTotal: number };
}

function fmtEta(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

function Tile({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warning" | "critical";
}) {
  const color = tone === "critical" ? "text-destructive" : tone === "warning" ? "text-amber-500" : "";
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function OverviewPanel() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/overview").then((r) => r.json()).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const f = data?.forecast;
  const rl = data?.rateLimit;
  const util = f?.utilization;
  const resetAt = f?.resetAt ?? rl?.resetAt ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" /> Live status
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          icon={<AlertTriangle className="size-3.5" />}
          label="Rate limit"
          value={f?.status ?? rl?.unifiedStatus ?? "—"}
          hint={resetAt ? `window resets ${new Date(resetAt).toLocaleTimeString()}` : rl?.retryAfter ? `retry in ${rl.retryAfter}s` : "from last response"}
          tone={f?.level}
        />
        <Tile
          icon={<Gauge className="size-3.5" />}
          label="5h window"
          value={util != null ? `${Math.round(util * 100)}%` : "—"}
          hint={
            util == null
              ? "utilization not reported"
              : f?.etaToLimitMs != null
                ? `${fmtEta(f.etaToLimitMs)} to limit at this pace`
                : "pace flat / unknown"
          }
          tone={f?.level}
        />
        <Tile
          icon={<Layers className="size-3.5" />}
          label="In flight"
          value={data ? `${data.limiter.inFlight}/${data.limiter.max}` : "—"}
          hint={
            data
              ? `${data.limiter.queued} queued · ${data.limiter.coalescedTotal} coalesced`
              : "concurrency"
          }
          tone={data && data.limiter.queued > 0 ? "warning" : undefined}
        />
        <Tile
          icon={<Wallet className="size-3.5" />}
          label="Spend today"
          value={`$${(data?.budget.today ?? 0).toFixed(2)}`}
          hint={
            data?.budget.enabled
              ? `of $${data.budget.dailyUsd} · $${(data.budget.month ?? 0).toFixed(2)}/mo`
              : `$${(data?.budget.month ?? 0).toFixed(2)} this month`
          }
          tone={data?.budget.exceeded ? "critical" : undefined}
        />
        <Tile
          icon={<Database className="size-3.5" />}
          label="Response cache"
          value={`${Math.round((data?.cache.hitRate ?? 0) * 100)}%`}
          hint={`${data?.cache.hits ?? 0} hits · ${data?.cache.entries ?? 0} stored`}
        />
      </CardContent>
    </Card>
  );
}
