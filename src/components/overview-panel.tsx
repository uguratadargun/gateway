"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Database, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Overview {
  rateLimit: {
    updatedAt: number;
    unifiedStatus: string | null;
    requestsRemaining: number | null;
    tokensRemaining: number | null;
    resetsAt: string | null;
    retryAfter: number | null;
  } | null;
  budget: {
    enabled: boolean;
    today: number;
    month: number;
    dailyUsd: number;
    monthlyUsd: number;
    exceeded: boolean;
  };
  cache: { hits: number; misses: number; entries: number; hitRate: number };
}

function Tile({
  icon,
  label,
  value,
  hint,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${warn ? "text-destructive" : ""}`}>
        {value}
      </div>
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

  const rl = data?.rateLimit;
  const rlStatus = rl?.unifiedStatus;
  const rlWarn = rlStatus === "allowed_warning" || rlStatus === "rejected";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" /> Live status
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          icon={<AlertTriangle className="size-3.5" />}
          label="Rate limit"
          value={rlStatus ?? "—"}
          hint={
            rl?.resetsAt
              ? `resets ${new Date(rl.resetsAt).toLocaleTimeString()}`
              : rl?.retryAfter
                ? `retry in ${rl.retryAfter}s`
                : "from last response"
          }
          warn={rlWarn}
        />
        <Tile
          icon={<Activity className="size-3.5" />}
          label="Tokens left"
          value={rl?.tokensRemaining != null ? Intl.NumberFormat().format(rl.tokensRemaining) : "—"}
          hint={rl?.requestsRemaining != null ? `${rl.requestsRemaining} requests` : "current window"}
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
          warn={data?.budget.exceeded}
        />
        <Tile
          icon={<Database className="size-3.5" />}
          label="Cache"
          value={`${Math.round((data?.cache.hitRate ?? 0) * 100)}%`}
          hint={`${data?.cache.hits ?? 0} hits · ${data?.cache.entries ?? 0} stored`}
        />
      </CardContent>
    </Card>
  );
}
