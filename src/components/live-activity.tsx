"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ActivityEvent {
  ts: number;
  kind: "request" | "queue" | "throttle" | "fallback";
  endpoint?: string;
  requested?: string;
  model?: string;
  tier?: string;
  status?: number;
  stream?: boolean;
  fromCache?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  note?: string;
  keyId?: string | null;
  userId?: string | null;
  accountId?: string | null;
  providerId?: string | null;
  caller?: string;
  servedBy?: string;
}

const kindVariant: Record<ActivityEvent["kind"], "default" | "secondary" | "destructive" | "success"> = {
  request: "secondary",
  queue: "default",
  throttle: "destructive",
  fallback: "default",
};

/** "" means unset. A field this event's kind never carries is `undefined` —
 *  distinct from `null`, which means the kind carries it but it has no value
 *  (an unkeyed request, say) — and an `undefined` field always passes: a
 *  tier-filtered feed keeps showing `queue`/`throttle` (no tier), and a
 *  person- or served-filtered feed keeps showing `fallback` (neither). */
function idMatches(value: string | null | undefined, filter: string): boolean {
  return value === undefined || value === filter;
}
function personMatches(e: ActivityEvent, person: string): boolean {
  if (!person) return true;
  if (person.startsWith("user:")) return idMatches(e.userId, person.slice("user:".length));
  if (person.startsWith("key:")) return idMatches(e.keyId, person.slice("key:".length));
  return true;
}
function servedMatches(e: ActivityEvent, served: string): boolean {
  if (!served) return true;
  if (served.startsWith("account:")) return idMatches(e.accountId, served.slice("account:".length));
  if (served.startsWith("provider:")) return idMatches(e.providerId, served.slice("provider:".length));
  return true;
}
function tierMatches(e: ActivityEvent, tier: string): boolean {
  return !tier || e.tier === undefined || e.tier === tier;
}

export function LiveActivity({
  person = "",
  served = "",
  tier = "",
}: {
  /** "user:<id>" / "key:<id>", or "" for no filter. */
  person?: string;
  /** "account:<id>" / "provider:<id>", or "" for no filter. */
  served?: string;
  tier?: string;
} = {}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/activity/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ActivityEvent;
        setEvents((prev) => [e, ...prev].slice(0, 40));
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, []);

  // The 40-event window is kept unfiltered so a filter change re-shows
  // whatever of it already matches, rather than only what arrives after.
  const visible = events.filter((e) => personMatches(e, person) && servedMatches(e, served) && tierMatches(e, tier));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className={`size-4 ${connected ? "text-emerald-500" : "text-muted-foreground"}`} /> Live
        </CardTitle>
        <span className="text-xs text-muted-foreground">{connected ? "streaming" : "connecting…"}</span>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {events.length === 0 ? "Waiting for requests…" : "Nothing in view matches the filter."}
          </p>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {visible.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex flex-wrap items-center gap-2 border-t py-1 first:border-t-0">
                <span className="tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                <Badge variant={kindVariant[e.kind]}>{e.kind}</Badge>
                {e.kind === "request" ? (
                  <>
                    {e.caller && (
                      <Badge variant="outline" className="max-w-[9rem] truncate" title={e.caller}>
                        {e.caller}
                      </Badge>
                    )}
                    {e.servedBy && (
                      <span className="max-w-[9rem] truncate text-muted-foreground" title={e.servedBy}>
                        {e.servedBy}
                      </span>
                    )}
                    <span className="text-muted-foreground">{e.endpoint}</span>
                    <span>{e.requested} → {e.model ?? e.tier}</span>
                    {e.model && e.tier && e.model !== e.tier && <span className="text-muted-foreground">as {e.tier}</span>}
                    {e.fromCache && <Badge variant="success">cache</Badge>}
                    {e.inputTokens != null && (
                      <span className="text-muted-foreground">
                        {e.inputTokens}/{e.outputTokens}{e.cacheReadTokens ? ` (+${e.cacheReadTokens} cached)` : ""}
                      </span>
                    )}
                    {e.durationMs != null && <span className="text-muted-foreground">{e.durationMs}ms</span>}
                    <span className={`ml-auto ${(e.status ?? 0) < 300 ? "text-emerald-500" : "text-destructive"}`}>{e.status}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{e.note}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
