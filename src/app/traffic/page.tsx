"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";

import { LiveActivity } from "@/components/live-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface TrafficEntry {
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
}

export default function TrafficPage() {
  const [entries, setEntries] = useState<TrafficEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  async function load() {
    const r = await fetch("/api/traffic");
    setEntries((await r.json()).entries);
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  async function clear() {
    await fetch("/api/traffic", { method: "DELETE" });
    await load();
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Traffic</h1>
          <p className="text-sm text-muted-foreground">Live feed and local request/response log (truncated).</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => (window.location.href = "/api/export?what=traffic&format=json")}>
            <Download /> Export
          </Button>
          <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="icon" onClick={clear} aria-label="Clear">
            <Trash2 />
          </Button>
        </div>
      </header>

      <LiveActivity />

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No traffic yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e, i) => (
            <Card key={i} className="overflow-hidden">
              <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(open === i ? null : i)}>
                <span className="text-xs tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                <Badge variant="outline">{e.endpoint}</Badge>
                <Badge variant="secondary">{e.tier}</Badge>
                {e.fromCache && <Badge variant="success">cache</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{e.routed}</span>
                <span className={`ml-auto text-xs ${e.status < 300 ? "text-emerald-500" : "text-destructive"}`}>{e.status}</span>
              </button>
              {open === i && (
                <CardContent className="space-y-3 border-t bg-muted/20 pt-3 text-xs">
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
      )}
    </main>
  );
}
