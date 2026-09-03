"use client";

import { useEffect, useMemo, useState } from "react";
import { Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Time-series analytics. Charts follow the dataviz method: one axis, thin
 * marks, 2px gaps, hairline grid, hover tooltip, legend for >=2 series, and a
 * table-view twin. Tier colors are the validated categorical slots (fixed
 * order, dark-surface steps) — identity never depends on color alone because
 * the legend + table carry it.
 */

type Range = "24h" | "7d" | "30d";
type Tier = "haiku" | "sonnet" | "opus" | "fable";

interface Bucket {
  ts: number;
  requests: number;
  tokens: number;
  cost: number;
  byTier: Record<string, { requests: number; tokens: number; cost: number }>;
}
interface Analytics {
  range: Range;
  bucketMs: number;
  buckets: Bucket[];
  byModel: Array<{ model: string; requests: number; tokens: number; cost: number }>;
  totals: { requests: number; tokens: number; cost: number; cacheHitRatio: number };
}

const TIERS: Tier[] = ["haiku", "sonnet", "opus", "fable"];
// Validated on the app's dark surface: adjacent CVD ΔE ≥ 8.4, normal ≥ 19.8, contrast ≥ 3:1.
const TIER_COLOR: Record<Tier, string> = {
  haiku: "#3987e5",
  sonnet: "#d95926",
  opus: "#199e70",
  fable: "#c98500",
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
function fmtBucket(ts: number, range: Range): string {
  const d = new Date(ts);
  return range === "24h" ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ---- Stacked bar chart (tokens per bucket, by tier) ------------------------

function StackedBars({
  buckets,
  range,
  metric,
  format,
}: {
  buckets: Bucket[];
  range: Range;
  metric: "tokens" | "cost" | "requests";
  format: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const padL = 44;
  const padB = 24;
  const padT = 8;
  const plotW = W - padL - 8;
  const plotH = H - padB - padT;
  const max = Math.max(1, ...buckets.map((b) => b[metric]));
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.max(2, slot - 2); // 2px surface gap
  const ticks = [0, 0.5, 1].map((f) => ({ y: padT + plotH - f * plotH, v: f * max }));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${metric} per period by tier`}>
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={padL} x2={W - 8} y1={t.y} y2={t.y} stroke="hsl(var(--border))" strokeWidth={1} />
            <text x={padL - 6} y={t.y + 3} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))">
              {format(t.v)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * slot + 1;
          let yTop = padT + plotH;
          const segs = TIERS.map((t) => {
            const v = b.byTier[t]?.[metric] ?? 0;
            const h = (v / max) * plotH;
            yTop -= h;
            return { t, v, y: yTop, h };
          });
          return (
            <g key={b.ts} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x - 1} y={padT} width={slot} height={plotH} fill="transparent" />
              {segs.map((s, k) =>
                s.h > 0 ? (
                  <rect
                    key={s.t}
                    x={x}
                    y={s.y + (k === segs.length - 1 ? 0 : 0)}
                    width={barW}
                    height={Math.max(0, s.h - (k < segs.length - 1 ? 2 : 0))}
                    rx={2}
                    fill={TIER_COLOR[s.t]}
                    opacity={hover == null || hover === i ? 1 : 0.5}
                  />
                ) : null,
              )}
              {(n <= 31 || i % Math.ceil(n / 12) === 0) && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
                  {n > 12 && i % Math.ceil(n / 12) !== 0 ? "" : fmtBucket(b.ts, range)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && buckets[hover] && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border bg-background px-2.5 py-1.5 text-xs shadow"
          style={{ left: `${Math.min(85, (padL + hover * slot) / W * 100)}%` }}
        >
          <div className="mb-1 font-medium">{fmtBucket(buckets[hover].ts, range)}</div>
          {TIERS.filter((t) => (buckets[hover].byTier[t]?.[metric] ?? 0) > 0).map((t) => (
            <div key={t} className="flex items-center gap-1.5 tabular-nums">
              <span className="inline-block size-2 rounded-sm" style={{ background: TIER_COLOR[t] }} />
              <span className="w-12 capitalize">{t}</span>
              <span>{format(buckets[hover].byTier[t][metric])}</span>
            </div>
          ))}
          <div className="mt-1 border-t pt-1 tabular-nums">total {format(buckets[hover][metric])}</div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {TIERS.map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: TIER_COLOR[t] }} />
            <span className="capitalize">{t}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Horizontal bars (per model, single series) ----------------------------

function ModelBars({ rows }: { rows: Analytics["byModel"] }) {
  const max = Math.max(1, ...rows.map((r) => r.requests));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.model} className="flex items-center gap-2 text-xs" onMouseEnter={() => setHover(r.model)} onMouseLeave={() => setHover(null)}>
          <span className="w-44 truncate font-mono text-muted-foreground">{r.model}</span>
          <div className="h-3 flex-1 rounded-sm bg-muted/40">
            <div className="h-3 rounded-sm" style={{ width: `${(r.requests / max) * 100}%`, background: "#3987e5", opacity: hover == null || hover === r.model ? 1 : 0.6 }} />
          </div>
          <span className="w-28 text-right tabular-nums">
            {r.requests} req · {fmtUsd(r.cost)}
          </span>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No data in this range.</p>}
    </div>
  );
}

// ---- Page ------------------------------------------------------------------

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>("24h");
  const [data, setData] = useState<Analytics | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/analytics?range=${range}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const nonEmpty = useMemo(() => data?.buckets.filter((b) => b.requests > 0) ?? [], [data]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Analytics</h1>
          <p className="text-sm text-muted-foreground">Tokens, cost, and requests over time — plan around your rate-limit windows.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg border bg-muted/40 p-1 text-sm">
            {(["24h", "7d", "30d"] as Range[]).map((r) => (
              <button key={r} onClick={() => setRange(r)} className={`rounded-md px-3 py-1 ${range === r ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}>
                {r}
              </button>
            ))}
          </div>
          <Button variant={table ? "default" : "outline"} size="sm" onClick={() => setTable(!table)}>
            <Table2 /> Table
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Requests" value={String(data?.totals.requests ?? 0)} />
        <Stat label="Tokens" value={fmtTokens(data?.totals.tokens ?? 0)} />
        <Stat label="Est. cost" value={fmtUsd(data?.totals.cost ?? 0)} hint="API-equivalent" />
        <Stat label="Prompt cache" value={`${Math.round((data?.totals.cacheHitRatio ?? 0) * 100)}%`} hint="of prompt tokens from cache" />
      </div>

      <div className={data ? "" : "opacity-60"}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tokens per {range === "24h" ? "hour" : "day"} by tier</CardTitle>
          </CardHeader>
          <CardContent>
            {data && !table && <StackedBars buckets={data.buckets} range={range} metric="tokens" format={fmtTokens} />}
            {data && table && <BucketTable buckets={nonEmpty} range={range} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Est. cost per {range === "24h" ? "hour" : "day"}</CardTitle>
          </CardHeader>
          <CardContent>{data && (table ? <BucketTable buckets={nonEmpty} range={range} metric="cost" /> : <StackedBars buckets={data.buckets} range={range} metric="cost" format={fmtUsd} />)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Requests by model</CardTitle>
          </CardHeader>
          <CardContent>{data && <ModelBars rows={data.byModel} />}</CardContent>
        </Card>
      </div>
    </main>
  );
}

function BucketTable({ buckets, range, metric = "tokens" }: { buckets: Bucket[]; range: Range; metric?: "tokens" | "cost" }) {
  const fmt = metric === "cost" ? fmtUsd : fmtTokens;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="pb-1 font-medium">Period</th>
            {TIERS.map((t) => (
              <th key={t} className="pb-1 font-medium capitalize">
                {t}
              </th>
            ))}
            <th className="pb-1 font-medium">Total</th>
            <th className="pb-1 font-medium">Req</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {buckets.map((b) => (
            <tr key={b.ts} className="border-t">
              <td className="py-1 pr-2">{fmtBucket(b.ts, range)}</td>
              {TIERS.map((t) => (
                <td key={t} className="py-1 pr-2 text-muted-foreground">
                  {b.byTier[t] ? fmt(b.byTier[t][metric]) : "—"}
                </td>
              ))}
              <td className="py-1 pr-2">{fmt(b[metric])}</td>
              <td className="py-1">{b.requests}</td>
            </tr>
          ))}
          {buckets.length === 0 && (
            <tr>
              <td colSpan={7} className="py-2 text-muted-foreground">
                No data in this range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
