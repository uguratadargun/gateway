"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, FileText, GitBranch, Radio, RefreshCw, Search, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DecisionView } from "@/components/decision-view";
import { TeamPicker, useTeamScope, withTeam } from "@/components/team-picker";
import type { ActivityCard, DocumentCard, FeatureCard, FeatureDetail, InterfaceCard, MemorySearchResult } from "@/memory/cards";

/** One connected repository's read, as `/api/memory/index` reports it. */
interface RecordRepo {
  repo: string;
  repoId: string | null;
  teamId: string | null;
  ref: string | null;
  commit: string | null;
  indexedAt: number | null;
  error: string | null;
  docs: number;
}

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
  const [note, setNote] = useState<string | null>(null);
  const [repos, setRepos] = useState<RecordRepo[]>([]);
  const [reading, setReading] = useState(false);

  const loadRepos = useCallback(async () => {
    const r = await fetch("/api/memory/index");
    const data = await r.json();
    setRepos(data.repos ?? []);
  }, []);

  useEffect(() => {
    void loadRepos().catch(() => {});
  }, [loadRepos]);

  /** Reads every connected repository's base branch now: git and code, no model. */
  async function readRepositories() {
    setReading(true);
    setError(null);
    try {
      const r = await fetch("/api/memory/index", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not read the repositories");
      setRepos(data.repos ?? []);
      const outcomes = (data.outcomes ?? []) as Array<{ ok: boolean; read?: number; merged?: number; renamed?: number; stale?: number }>;
      const sum = (k: "read" | "merged" | "renamed" | "stale") => outcomes.reduce((n, o) => n + (o[k] ?? 0), 0);
      setNote(
        `Read ${outcomes.filter((o) => o.ok).length} of ${outcomes.length} repositories: ${sum("read")} document${sum("read") === 1 ? "" : "s"} new or changed, ` +
          `${sum("merged")} decision${sum("merged") === 1 ? "" : "s"} found merged, ${sum("renamed")} renumbered record${sum("renamed") === 1 ? "" : "s"} followed, ` +
          `${sum("stale")} describing code that is gone.`,
      );
      await loadFeatures();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

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
    setNote(null);
    setError(null);
    try {
      const r = await fetch(withTeam("/api/memory/backfill", team), { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not queue");
      setNote(data.queued ? `${data.queued} run${data.queued === 1 ? "" : "s"} queued; each run's page shows what was recorded.` : "Every finished run in this tree already has a record.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Rewrites one team's page on the open feature from all of its decisions: one model call, now. */
  async function consolidate(featureId: string, teamId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(withTeam(`/api/memory/consolidate?id=${encodeURIComponent(featureId)}&teamId=${encodeURIComponent(teamId)}`, team), { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not consolidate");
      if (data.status !== "done") setError(`consolidation ${data.status}: ${data.reason ?? ""}`);
      await openFeature(featureId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Forgets one decision, then reloads whatever is open so it is gone from the page too. */
  async function forgetDecision(id: string) {
    setError(null);
    try {
      const r = await fetch(withTeam(`/api/memory/decisions/${encodeURIComponent(id)}`, team), { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not forget it");
      setResult((prev) => (prev ? { ...prev, decisions: prev.decisions.filter((d) => d.id !== id) } : prev));
      if (detail) await openFeature(detail.feature.id);
      await loadFeatures();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Forgets a catalogue entry and everything filed under it. */
  async function forgetFeature(id: string, name: string) {
    if (
      !confirm(
        `Forget "${name}"?\n\nThe catalogue entry goes, with every team's page on it, its consolidation history, and every decision filed under it. The runs stay. This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const r = await fetch(withTeam(`/api/memory/features/${encodeURIComponent(id)}`, team), { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "could not forget it");
      const gone = data.forgotten?.decisions ?? 0;
      setNote(`Forgot "${name}" and ${gone} decision${gone === 1 ? "" : "s"} under it.`);
      setDetail(null);
      setResult(null);
      await loadFeatures();
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
            What the team&apos;s runs decided and what its repositories say about themselves — why, how, where, which commits, and who is on what right now. Read by the recall node before every plan.
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
          <Button
            variant="ghost"
            size="sm"
            disabled={reading}
            onClick={() => void readRepositories()}
            title="Read every connected repository's base branch now: design docs, decision records, specs, which work landed. Git and code, no model."
          >
            <RefreshCw className={reading ? "animate-spin" : undefined} /> Read repositories
          </Button>
        </div>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {result && (
          <p className="text-xs text-muted-foreground">
            Searched {result.scope.teams.join(", ")} · own team {result.scope.own} first
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Card>

      {result && (
        <div className="space-y-3">
          {(result.inFlight?.length ?? 0) > 0 && <InFlight list={result.inFlight!} />}
          {(result.documents?.length ?? 0) > 0 && (
            <Card className="space-y-2 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The repositories&apos; own record</div>
              {result.documents!.map((d) => (
                <DocumentRow key={`${d.repo}:${d.path}`} doc={d} />
              ))}
            </Card>
          )}
          {(result.interfaces?.length ?? 0) > 0 && <Interfaces list={result.interfaces!} />}
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
              <DecisionView key={d.id} decision={d} onForget={() => void forgetDecision(d.id)} />
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
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={() => void forgetFeature(detail.feature.id, detail.feature.name)}
              title="Forget this feature, every team's page on it, and every decision filed under it."
            >
              <Trash2 /> Forget
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
              Close
            </Button>
          </div>
          {detail.feature.aliases.length > 0 && <p className="text-xs text-muted-foreground">also: {detail.feature.aliases.join(", ")}</p>}
          {detail.feature.summary && <p className="text-sm">{detail.feature.summary}</p>}
          {(detail.documents?.length ?? 0) > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Each repository&apos;s design doc</div>
              {detail.documents!.map((d) => (
                <DocumentRow key={`${d.repo}:${d.path}`} doc={d} />
              ))}
            </div>
          )}
          <div className="space-y-2">
            {detail.implementations.length === 0 && !detail.documents?.length && (
              <p className="text-sm text-muted-foreground">No team has recorded an implementation yet.</p>
            )}
            {detail.implementations.map((i) => (
              <div key={i.team} className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{i.team}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {i.decisionCount} decision{i.decisionCount === 1 ? "" : "s"} · {i.updatedAt.slice(0, 10)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => void consolidate(detail.feature.id, i.team)}
                    title="Rewrite this team's summary and pitfalls from every decision under the feature. One model call."
                  >
                    Consolidate
                  </Button>
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
          {detail.consolidations && detail.consolidations.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Consolidation passes</div>
              {detail.consolidations.map((c, n) => (
                <div key={n} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={c.status === "done" ? "success" : c.status === "failed" ? "destructive" : "secondary"}>{c.status}</Badge>
                  <span>{c.team}</span>
                  <span>{c.at.slice(0, 16).replace("T", " ")}</span>
                  <span>
                    read {c.decisionsRead}, closed {c.superseded}
                  </span>
                  {c.model && <span>{c.model}</span>}
                  {c.costUsd != null && <span>${c.costUsd.toFixed(4)}</span>}
                  {c.error && <span className="text-destructive">{c.error}</span>}
                </div>
              ))}
            </div>
          )}
          {detail.decisions.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decisions</div>
              {detail.decisions.map((d) => (
                <DecisionView key={d.id} decision={d} onForget={() => void forgetDecision(d.id)} />
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
              Empty so far. A feature appears here when a run&apos;s recorder files its decisions under one, or when a connected
              repository has a design doc for it.
            </p>
          )}
          {features.map((f) => (
            <FeatureRow key={f.id} feature={f} onOpen={() => void openFeature(f.id)} />
          ))}
        </Card>
      )}

      {!result && !detail && (
        <Card className="space-y-2 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Repositories read</div>
          {repos.length === 0 && <p className="text-sm text-muted-foreground">No repository is connected. Connect one on the Repos page and its record is read here.</p>}
          {repos.map((r) => (
            <div key={r.repo} className="flex flex-wrap items-center gap-2 text-sm">
              <GitBranch className="size-3.5 text-muted-foreground" />
              <span className="font-medium">{r.repoId ?? r.repo}</span>
              {r.teamId ? <Badge variant="secondary">{r.teamId}</Badge> : <span className="text-xs text-muted-foreground">no team</span>}
              {r.commit && (
                <span className="font-mono text-xs text-muted-foreground">
                  {r.ref} @ {r.commit.slice(0, 8)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{r.docs} documents</span>
              <span className="ml-auto text-xs text-muted-foreground">{r.indexedAt ? `read ${new Date(r.indexedAt).toLocaleString()}` : "not read yet"}</span>
              {r.error && <span className="w-full text-xs text-destructive">{r.error}</span>}
            </div>
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

/** Runs of other people in the tree going now on work with the same words: first, because everything else here has already ended. */
function InFlight({ list }: { list: ActivityCard[] }) {
  return (
    <Card className="space-y-2 border-amber-500/50 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <Radio className="size-3.5" /> Running right now elsewhere in the tree
      </div>
      {list.map((a) => (
        <div key={a.executionId} className="rounded-md border p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{a.team}</Badge>
            {a.person && <span>{a.person}</span>}
            <span className="text-xs text-muted-foreground">
              {a.workflow} · {a.status} since {a.startedAt.slice(0, 16).replace("T", " ")}
              {a.repo ? ` · ${a.repo}` : ""}
            </span>
            <Link href={`/executions/${a.executionId}`} className="ml-auto font-mono text-xs text-muted-foreground hover:underline">
              run {a.executionId.slice(0, 8)}
            </Link>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{a.task}</p>
          {a.shared.length > 0 && <p className="mt-1 text-xs text-muted-foreground">in common: {a.shared.join(", ")}</p>}
        </div>
      ))}
    </Card>
  );
}

function DocumentRow({ doc: d }: { doc: DocumentCard }) {
  const kind = d.kind === "decision" ? "decision record" : d.kind === "design" ? "design doc" : d.kind;
  return (
    <div className="rounded-md border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{d.title}</span>
        <span className="text-xs text-muted-foreground">{kind}</span>
        {d.team && <Badge variant="secondary">{d.team}</Badge>}
        {d.status && <span className="text-xs text-muted-foreground">{d.status}</span>}
        <code className="ml-auto text-xs text-muted-foreground">
          {d.repoId ?? d.repo}:{d.path} @ {d.commit.slice(0, 8)}
        </code>
      </div>
      {d.summary && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{d.summary}</p>}
      {(d.interfaces?.length ?? 0) > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.interfaces!.map((i) => (
            <code key={`${i.role}:${i.name}`} className="rounded bg-muted px-1 text-[10px]">
              {i.role} {i.name}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/** Who provides and who consumes each interface the words named. */
function Interfaces({ list }: { list: InterfaceCard[] }) {
  return (
    <Card className="space-y-1 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Interfaces between repositories</div>
      {list.map((i) => (
        <div key={`${i.repo}:${i.path}:${i.role}:${i.name}`} className="flex flex-wrap items-center gap-2 text-sm">
          <code>{i.name}</code>
          <Badge variant={i.role === "provides" ? "success" : "secondary"}>{i.role}</Badge>
          {i.team && <span>{i.team}</span>}
          <code className="text-xs text-muted-foreground">
            {i.repoId ?? i.repo}:{i.path}
          </code>
          {i.note && <span className="text-xs text-muted-foreground">{i.note}</span>}
        </div>
      ))}
    </Card>
  );
}
