"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The on-disk request/response log — what `/api/traffic` holds, newest
 * first, narrowed by the filter bar the page renders above both tabs. Moved
 * out of `traffic/page.tsx` (the `*-panel.tsx` convention) so the page can
 * own tabs, the filter bar and the URL without also owning the polling loop
 * and the row markup.
 */

interface TrafficRow {
  ts: number;
  endpoint: string;
  requested: string;
  routed: string;
  tier: string;
  status: number;
  stream: boolean;
  fromCache: boolean;
  requestPreview: string;
  responsePreview: string;
  accountId: string | null;
  providerId: string | null;
  keyId: string | null;
  caller: string;
  servedBy: string;
  team: string;
  /** This exchange's own id, copyable straight into the request-id filter. */
  requestId: string;
  /** The run this row was made for, and where in it — null on either when
   *  there was no run, or the run or step is gone. */
  executionId: string | null;
  workflowId: string | null;
  nodeId: string | null;
}

export interface TrafficLogFilters {
  /** "" means unset — every filter here is "any" until it isn't. */
  person: string;
  served: string;
  tier: string;
  requestId: string;
}

function query(f: TrafficLogFilters): string {
  const p = new URLSearchParams();
  if (f.person) p.set("person", f.person);
  if (f.served) p.set("served", f.served);
  if (f.tier) p.set("tier", f.tier);
  if (f.requestId) p.set("request", f.requestId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function CopyId({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label="Copy request id"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // Clipboard needs a secure context; the id is still on screen either way.
        }
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}

/** Names a row's run the way the executions list does (`workflowId · nodeId`);
 *  drops the node when it did not resolve, and the whole link when there is
 *  no run at all — a row made outside any run has nothing to point to. */
function RunLink({
  executionId,
  workflowId,
  nodeId,
}: {
  executionId: string | null;
  workflowId: string | null;
  nodeId: string | null;
}) {
  if (!executionId) return null;
  const label = workflowId ? (nodeId ? `${workflowId} · ${nodeId}` : workflowId) : executionId;
  return (
    <Link
      href={`/executions/${executionId}`}
      className="max-w-[10rem] truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
      title={label}
    >
      {label}
    </Link>
  );
}

/**
 * `reloadKey` is the page's Refresh and Clear buttons: any change to it
 * re-runs the effect, which fetches at once rather than leaving the list up to
 * six seconds stale after a person has just asked for it.
 */
export function TrafficLog({ person, served, tier, requestId, reloadKey = 0 }: TrafficLogFilters & { reloadKey?: number }) {
  const [entries, setEntries] = useState<TrafficRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await fetch(`/api/traffic${query({ person, served, tier, requestId })}`);
      const d = await r.json();
      if (!cancelled) setEntries(d.entries ?? []);
    }
    load();
    const t = setInterval(load, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [person, served, tier, requestId, reloadKey]);

  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No traffic yet.</p>;

  return (
    <div className="space-y-2">
      {entries.map((e, i) => (
        <Card key={e.requestId || i} className="overflow-hidden">
          <button
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40"
            onClick={() => setOpen(open === i ? null : i)}
          >
            <span className="text-xs tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
            <Badge variant="outline" className="max-w-[9rem] truncate" title={e.caller}>
              {e.caller}
            </Badge>
            <Badge variant="secondary">{e.tier}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{e.routed}</span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="max-w-[9rem] truncate text-xs text-muted-foreground" title={e.servedBy}>
              {e.servedBy}
            </span>
            <RunLink executionId={e.executionId} workflowId={e.workflowId} nodeId={e.nodeId} />
            <span className={`ml-auto text-xs ${e.status < 300 ? "text-emerald-500" : "text-destructive"}`}>{e.status}</span>
          </button>
          {open === i && (
            <CardContent className="space-y-3 border-t bg-muted/20 pt-3 text-xs">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <Detail label="Caller" value={e.caller} />
                <Detail label="Team" value={e.team || "—"} />
                <Detail label="Key" value={e.keyId ?? "—"} mono />
                <Detail label="Endpoint" value={e.endpoint} />
                <Detail label="Requested" value={e.requested} mono />
                <Detail label="Served by" value={e.servedBy} />
                <Detail label="Routed" value={e.routed} mono />
                <Detail label="Account / provider" value={e.accountId ?? e.providerId ?? "—"} mono />
              </dl>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Request id</span>
                <span className="font-mono text-xs">{e.requestId}</span>
                <CopyId value={e.requestId} />
              </div>
              <div>
                <div className="mb-1 font-medium text-muted-foreground">Request</div>
                <pre className="overflow-x-auto rounded bg-background p-2">{e.requestPreview}</pre>
              </div>
              <div>
                <div className="mb-1 font-medium text-muted-foreground">Response</div>
                <pre className="overflow-x-auto rounded bg-background p-2">{e.responsePreview}</pre>
              </div>
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}
