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
}

const kindVariant: Record<ActivityEvent["kind"], "default" | "secondary" | "destructive" | "success"> = {
  request: "secondary",
  queue: "default",
  throttle: "destructive",
  fallback: "default",
};

export function LiveActivity() {
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

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className={`size-4 ${connected ? "text-emerald-500" : "text-muted-foreground"}`} /> Live
        </CardTitle>
        <span className="text-xs text-muted-foreground">{connected ? "streaming" : "connecting…"}</span>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Waiting for requests…</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex flex-wrap items-center gap-2 border-t py-1 first:border-t-0">
                <span className="tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                <Badge variant={kindVariant[e.kind]}>{e.kind}</Badge>
                {e.kind === "request" ? (
                  <>
                    <span className="text-muted-foreground">{e.endpoint}</span>
                    <span>{e.requested} → {e.tier}</span>
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
