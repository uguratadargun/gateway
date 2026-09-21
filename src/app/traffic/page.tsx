"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";

import { LiveActivity } from "@/components/live-activity";
import { TrafficLog } from "@/components/traffic-log";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";

/**
 * Two tabs on one route: `live`, the in-process feed of the last 40 events,
 * lost on restart; `log`, what was actually served, on disk, retained up to
 * settings' `traffic.maxRows` rows (5,000 by default). One filter bar above
 * both narrows both — the log server-side, the live feed over its own buffer.
 */

type Tab = "live" | "log";

interface Facets {
  people: Array<{ value: string; label: string }>;
  served: Array<{ value: string; label: string }>;
  tiers: string[];
}

const EMPTY_FACETS: Facets = { people: [], served: [], tiers: [] };

function trafficExportUrl(f: { person: string; served: string; tier: string; request: string }): string {
  const p = new URLSearchParams({ what: "traffic", format: "json" });
  if (f.person) p.set("person", f.person);
  if (f.served) p.set("served", f.served);
  if (f.tier) p.set("tier", f.tier);
  if (f.request) p.set("request", f.request);
  return `/api/export?${p.toString()}`;
}

export default function TrafficPage() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("live");
  const [person, setPerson] = useState("");
  const [served, setServed] = useState("");
  const [tier, setTier] = useState("");
  const [request, setRequest] = useState("");
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);

  // Read once from the URL — these pages are statically prerendered, so
  // useSearchParams would need a Suspense boundary around each of them.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "log") setTab("log");
    setPerson(q.get("person") ?? "");
    setServed(q.get("served") ?? "");
    setTier(q.get("tier") ?? "");
    setRequest(q.get("request") ?? "");
    setReady(true);
  }, []);

  // Write every change back, deleting a parameter once it is back at its default.
  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    const set = (key: string, value: string, isDefault: boolean) => {
      if (isDefault) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    set("tab", tab, tab === "live");
    set("person", person, person === "");
    set("served", served, served === "");
    set("tier", tier, tier === "");
    set("request", request, request === "");
    window.history.replaceState(null, "", url.toString());
  }, [ready, tab, person, served, tier, request]);

  // The filter bar's options come from `/api/traffic`'s facets, computed over
  // the whole table — fetched here, independent of which tab is open, so the
  // bar has something to offer even while the live tab is the one showing.
  async function loadFacets() {
    const r = await fetch("/api/traffic?limit=1");
    const d = await r.json();
    setFacets(d.facets ?? EMPTY_FACETS);
  }
  useEffect(() => {
    if (!ready) return;
    loadFacets();
    const t = setInterval(loadFacets, 6000);
    return () => clearInterval(t);
  }, [ready]);

  async function clear() {
    await fetch("/api/traffic", { method: "DELETE" });
    await loadFacets();
  }

  const filtered = person !== "" || served !== "" || tier !== "" || request !== "";
  function clearFilters() {
    setPerson("");
    setServed("");
    setTier("");
    setRequest("");
  }

  if (!ready) return null;

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Traffic</h1>
          <p className="text-sm text-muted-foreground">
            The live feed is this process&apos;s last events, lost on restart. The log is what was served, on disk,
            up to 5,000 rows — different data, not two views of one thing.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => (window.location.href = trafficExportUrl({ person, served, tier, request }))}>
            <Download /> Export
          </Button>
          <Button variant="ghost" size="icon" onClick={loadFacets} aria-label="Refresh">
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="icon" onClick={clear} aria-label="Clear">
            <Trash2 />
          </Button>
        </div>
      </header>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
            <option value="">Any person</option>
            {facets.people.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          <Select value={served} onChange={(e) => setServed(e.target.value)} aria-label="Served by">
            <option value="">Any account/provider</option>
            {facets.served.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
            <option value="">Any tier</option>
            {facets.tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input
            className="w-64 font-mono text-xs"
            placeholder="Request id"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      <Tabs
        tabs={[
          { id: "live", label: "Live" },
          { id: "log", label: "Log" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "live" ? (
        <LiveActivity person={person} served={served} tier={tier} />
      ) : (
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-medium">Request log</h2>
            <p className="text-xs text-muted-foreground">
              Does not include cache hits, refusals (400/401/402/429/503), or the proxied /v1/models, count_tokens
              and batches/* calls.
            </p>
          </div>
          <TrafficLog person={person} served={served} tier={tier} requestId={request} />
        </div>
      )}
    </main>
  );
}
