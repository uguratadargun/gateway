"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Database, Gauge, Layers, Wallet } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";

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
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" /> Live status
        </CardTitle>
        <CardDescription>What the gateway is doing right now; refreshed every 8 seconds.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          icon={<AlertTriangle className="size-3.5" />}
          label="Rate limit"
          value={f?.status ?? rl?.unifiedStatus ?? "—"}
          hint={resetAt ? `window resets ${new Date(resetAt).toLocaleTimeString()}` : rl?.retryAfter ? `retry in ${rl.retryAfter}s` : "from last response"}
          tone={f?.level}
        />
        <Stat
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
        <Stat
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
        <Stat
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
        <Stat
          icon={<Database className="size-3.5" />}
          label="Response cache"
          value={`${Math.round((data?.cache.hitRate ?? 0) * 100)}%`}
          hint={`${data?.cache.hits ?? 0} hits · ${data?.cache.entries ?? 0} stored`}
        />
      </CardContent>
    </Card>
  );
}
