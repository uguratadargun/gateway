"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DecisionView } from "@/components/decision-view";
import { TeamPicker, useTeamScope, withTeam } from "@/components/team-picker";
import type { FeatureCard, FeatureDetail, MemorySearchResult } from "@/memory/cards";

/**
 * The team's memory, read by a person: what earlier runs decided, by words
 * or by path, and the catalogue of features with how each team built them.
 * The same two reads a run's recall node makes, so what the planner was
 * told can be seen here.
 */
export default function MemoryPage() {
  const { team, setTeam, teams, ready } = useTeamScope();
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [result, setResult] = useState<MemorySearchResult | null>(null);
  const [features, setFeatures] = useState<FeatureCard[]>([]);
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<string | null>(null);

  const loadFeatures = useCallback(async () => {
    const r = await fetch(withTeam("/api/memory/features", team));
    const data = await r.json();
    setFeatures(data.features ?? []);
  }, [team]);

  useEffect(() => {
    if (!ready) return;
    setDetail(null);
    setResult(null);
    void loadFeatures().catch(() => {});
  }, [ready, loadFeatures]);

  async function search() {
    if (!query.trim() && !path.trim()) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (path.trim()) params.append("path", path.trim());
      params.set("limit", "30");
      const r = await fetch(withTeam(`/api/memory/search?${params}`, team));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "search failed");
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Runs that ended before memory existed are recorded on request, not quietly: each is a model call. */
  async function recordEarlierRuns() {
    setBackfill(null);
    setError(null);
    try {
      const r = await fetch(withTeam("/api/memory/backfill", team), { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not queue");
      setBackfill(data.queued ? `${data.queued} run${data.queued === 1 ? "" : "s"} queued; each run's page shows what was recorded.` : "Every finished run in this tree already has a record.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function openFeature(id: string) {
    setError(null);
    try {
      const r = await fetch(withTeam(`/api/memory/features?id=${encodeURIComponent(id)}`, team));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not read the feature");
      setDetail(data);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-[1200px] space-y-4 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Memory</h1>
          <p className="text-sm text-muted-foreground">
            What the team&apos;s runs decided — why, how, where, and which commits. Read by the recall node before every plan.
          </p>
        </div>
        <TeamPicker team={team} teams={teams} onChange={setTeam} />
      </header>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-64 flex-1"
            placeholder="Words: the feature, the problem, the component…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <Input
            className="w-64 font-mono text-xs"
            placeholder="Path prefix, e.g. src/sync"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <Button size="sm" onClick={() => void search()} disabled={busy || (!query.trim() && !path.trim())}>
            <Search /> Search
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void recordEarlierRuns()} title="Queue every finished run of this tree that has no record yet. Each is one model call.">
            Record earlier runs
          </Button>
        </div>
        {backfill && <p className="text-xs text-muted-foreground">{backfill}</p>}
        {result && (
          <p className="text-xs text-muted-foreground">
            Searched {result.scope.teams.join(", ")} · own team {result.scope.own} first
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Card>

      {result && (
        <div className="space-y-3">
          {result.features.length > 0 && (
            <Card className="space-y-2 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Features that match</div>
              {result.features.map((f) => (
                <FeatureRow key={f.id} feature={f} onOpen={() => void openFeature(f.id)} />
              ))}
            </Card>
          )}
          <Card className="space-y-3 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {result.decisions.length} decision{result.decisions.length === 1 ? "" : "s"}
            </div>
            {result.decisions.length === 0 && <p className="text-sm text-muted-foreground">Nothing in memory matches.</p>}
            {result.decisions.map((d) => (
              <DecisionView key={d.id} decision={d} />
            ))}
          </Card>
        </div>
      )}

      {detail && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" />
            <span className="font-medium">{detail.feature.name}</span>
            <code className="text-xs text-muted-foreground">{detail.feature.id}</code>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDetail(null)}>
              Close
            </Button>
          </div>
          {detail.feature.aliases.length > 0 && <p className="text-xs text-muted-foreground">also: {detail.feature.aliases.join(", ")}</p>}
          {detail.feature.summary && <p className="text-sm">{detail.feature.summary}</p>}
          <div className="space-y-2">
            {detail.implementations.length === 0 && <p className="text-sm text-muted-foreground">No team has recorded an implementation yet.</p>}
            {detail.implementations.map((i) => (
              <div key={i.team} className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{i.team}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {i.decisionCount} decision{i.decisionCount === 1 ? "" : "s"} · {i.updatedAt.slice(0, 10)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap">{i.summary || "(no summary yet)"}</p>
                {i.pitfalls && (
                  <p className="mt-2 whitespace-pre-wrap text-amber-700 dark:text-amber-400">
                    <span className="font-medium">Pitfalls: </span>
                    {i.pitfalls}
                  </p>
                )}
              </div>
            ))}
          </div>
          {detail.decisions.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decisions</div>
              {detail.decisions.map((d) => (
                <DecisionView key={d.id} decision={d} />
              ))}
            </div>
          )}
        </Card>
      )}

      {!result && !detail && (
        <Card className="space-y-2 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Catalogue</div>
          {features.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Empty so far. A feature appears here when a run&apos;s recorder files its decisions under one.
            </p>
          )}
          {features.map((f) => (
            <FeatureRow key={f.id} feature={f} onOpen={() => void openFeature(f.id)} />
          ))}
        </Card>
      )}
    </main>
  );
}

function FeatureRow({ feature, onOpen }: { feature: FeatureCard; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-md border p-2 text-left text-sm hover:bg-muted/40">
      <span className="font-medium">{feature.name}</span>
      <code className="text-xs text-muted-foreground">{feature.id}</code>
      <span className="ml-auto flex gap-1">
        {feature.teams.map((t) => (
          <Badge key={t} variant="secondary">
            {t}
          </Badge>
        ))}
        {feature.teams.length === 0 && <span className="text-xs text-muted-foreground">nobody yet</span>}
      </span>
    </button>
  );
}
