"use client";

import { useEffect, useState } from "react";
import { DownloadCloud, FolderGit2, Loader2, Plus, RefreshCw, Trash2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Connected repositories: where a run's worktree comes from, and what has to
 * happen before one can be worked in.
 *
 * The commands are shown, not hidden behind a spinner — they are guessed from
 * the lockfile and the guess is often nearly right, so the useful thing is to
 * put it in front of you before it runs rather than after it fails.
 *
 * Whose repository it is, is said here too. It decides who may ask about the
 * code, and it was reachable only over the API — so a repository connected in
 * the dashboard belonged to nobody, and nobody could see that it did.
 */

interface Team {
  id: string;
  name: string;
}

interface Repo {
  id: string;
  name: string;
  source: string;
  root: string;
  cloned: boolean;
  baseRef: string | null;
  setup: string[][];
  prepare: string[][];
  /** Whose repository this is; null = nobody has said, and anyone here may read it. */
  teamId: string | null;
  /** Where run branches are pushed so another team can read them; null = nowhere. */
  publicationRemote: string | null;
  /** Which branches that covers. Always concrete — the server resolves the default. */
  branchPolicy: string;
  status: "new" | "installing" | "ready" | "failed";
  lastSetupAt: number | null;
  lastSetupLog: string | null;
}

const STATUS: Record<Repo["status"], { variant: "default" | "success" | "destructive" | "outline"; label: string }> = {
  new: { variant: "outline", label: "not installed" },
  installing: { variant: "default", label: "installing…" },
  ready: { variant: "success", label: "ready" },
  failed: { variant: "destructive", label: "setup failed" },
};

/**
 * What assigning a team does, said once in both places it is chosen. Unowned
 * is the wider setting, not the safer one, and the sentence says so.
 */
const TEAM_NOTE = "Only that team and the teams in its tree may ask about this code. Unowned, anyone on this gate can.";

/** argv arrays as one command per line, which is how they are edited. */
function toText(cmds: string[][]): string {
  return cmds.map((c) => c.join(" ")).join("\n");
}
/** Split on whitespace: these are simple commands, and the field says so. */
function toArgv(text: string): string[][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/));
}

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [source, setSource] = useState("");
  const [setup, setSetup] = useState("");
  const [prepare, setPrepare] = useState("");
  const [team, setTeam] = useState("");
  const [detected, setDetected] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "detect" | "connect">(null);
  const [error, setError] = useState<string | null>(null);
  /** A refused team change, shown on the repository it was refused for. */
  const [assignError, setAssignError] = useState<{ id: string; message: string } | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/repos");
    if (r.ok) setRepos((await r.json()).repos);
  }
  useEffect(() => {
    load();
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d) => setTeams(d.teams ?? []))
      // The list is how a repository is assigned, not how the page works:
      // without it every repository still shows the team it already has.
      .catch(() => setTeams([]));
  }, []);

  /** Ask what gate would do, before anything is stored. */
  async function detect() {
    setBusy("detect");
    setError(null);
    const r = await fetch("/api/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) return setError(data.error ?? "could not read that repository");
    if (data.needsClone) {
      // A URL cannot be read without fetching it, and a look should not cost a
      // clone. Connect does that, and comes back with what it found.
      setSetup("");
      setPrepare("");
      setDetected(data.note);
      return;
    }
    setSetup(toText(data.detected.setup));
    setPrepare(toText(data.detected.prepare));
    setDetected(`${data.root} · detected from ${data.detected.reason}`);
  }

  async function connect() {
    setBusy("connect");
    setError(null);
    const r = await fetch("/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        setup: toArgv(setup),
        prepare: toArgv(prepare),
        ...(team ? { teamId: team } : {}),
      }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) return setError(data.error ?? "could not connect that repository");
    setSource("");
    setSetup("");
    setPrepare("");
    setTeam("");
    // Connecting a URL is the first time anything is known about it, so say
    // what the clone turned up rather than clearing the line to nothing.
    setDetected(data.detected?.reason ? `connected · detected from ${data.detected.reason}` : null);
    load();
  }

  /**
   * Hand a repository to a team, or to nobody. It applies on the change: there
   * is one value and no way to half-type it, and the row it lands in is what
   * decides whether another team's `gate:ask` may read this code at all.
   */
  async function assign(id: string, teamId: string) {
    const before = repos;
    setAssignError(null);
    setRepos((p) => p.map((r) => (r.id === id ? { ...r, teamId: teamId || null } : r)));
    const r = await fetch(`/api/repos/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: teamId || null }),
    });
    if (!r.ok) {
      // Put the old owner back rather than leaving one the server refused on
      // screen: this field is read as "who may see this code".
      setRepos(before);
      setAssignError({ id, message: (await r.json().catch(() => ({}))).error ?? "could not change the team" });
    }
  }

  async function pull(id: string) {
    setRepos((p) => p.map((r) => (r.id === id ? { ...r, status: "installing" } : r)));
    await fetch(`/api/repos/${id}/pull`, { method: "POST" });
    load();
  }

  async function reinstall(id: string) {
    setRepos((p) => p.map((r) => (r.id === id ? { ...r, status: "installing" } : r)));
    await fetch(`/api/repos/${id}/setup`, { method: "POST" });
    load();
  }

  async function forget(repo: Repo) {
    const fate = repo.cloned
      ? `The checkout gate cloned at ${repo.root} goes with it.`
      : `Your checkout at ${repo.root} is left alone.`;
    if (!confirm(`Forget "${repo.id}"?\n\n${fate}`)) return;
    setError(null);
    const r = await fetch(`/api/repos/${repo.id}`, { method: "DELETE" });
    const data = await r.json().catch(() => null);
    // A checkout that outlived its record is the one thing this page cannot
    // show any more, so the reason it did has to be said now or not at all.
    if (repo.cloned && data?.deleted && !data.checkoutRemoved) {
      setError(`Forgot "${repo.id}", but ${data.checkoutLeftAt} is still there: ${data.keptBecause}`);
    }
    load();
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <header>
        <h1 className="text-lg font-semibold">Repositories</h1>
        <p className="text-xs text-muted-foreground">
          Where a run works. Each run branches a fresh git worktree from the checkout, borrows its installed
          dependencies, and runs whatever the repo says a worktree still needs.
        </p>
      </header>

      <Card className="space-y-3 p-3">
        <div className="flex gap-2">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && source && detect()}
            placeholder="/path/to/repo  or  git@github.com:you/repo.git"
            spellCheck={false}
            className="h-8 font-mono text-xs"
          />
          <Button variant="outline" size="sm" onClick={detect} disabled={!source || busy !== null}>
            {busy === "detect" ? <Loader2 className="animate-spin" /> : <FolderGit2 />}
            Inspect
          </Button>
        </div>

        {detected && <p className="font-mono text-[11px] text-muted-foreground">{detected}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}

        {(detected || setup || prepare) && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  setup — once, in the checkout
                </span>
                <Textarea
                  value={setup}
                  onChange={(e) => setSetup(e.target.value)}
                  spellCheck={false}
                  placeholder="pnpm install"
                  className="h-20 resize-none font-mono text-xs"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  prepare — every worktree
                </span>
                <Textarea
                  value={prepare}
                  onChange={(e) => setPrepare(e.target.value)}
                  spellCheck={false}
                  placeholder="pnpm run build-protobuf"
                  className="h-20 resize-none font-mono text-xs"
                />
              </label>
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              One command per line. <strong>Setup</strong> is the install, run once here. <strong>Prepare</strong> is
              what a worktree still needs after it borrows those dependencies — generated sources, a transpile — because
              a worktree carries only what git tracks, and build output is normally gitignored.
            </p>
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">team</span>
              <Select value={team} onChange={(e) => setTeam(e.target.value)} className="text-xs">
                <option value="">nobody in particular</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <span className="text-[10px] leading-snug text-muted-foreground">{TEAM_NOTE}</span>
            </label>
            <Button size="sm" onClick={connect} disabled={!source || busy !== null}>
              {busy === "connect" ? <Loader2 className="animate-spin" /> : <Plus />}
              Connect and install
            </Button>
          </>
        )}
      </Card>

      {repos.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing connected yet.</p>}

      <div className="space-y-2">
        {repos.map((repo) => (
          <Card key={repo.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium">{repo.id}</span>
              <Badge variant={STATUS[repo.status].variant} className="text-[10px]">
                {STATUS[repo.status].label}
              </Badge>
              {repo.cloned && (
                <Badge variant="outline" className="text-[10px]">
                  cloned by gate
                </Badge>
              )}
              <label className="flex items-center gap-1.5" title={TEAM_NOTE}>
                <Users className="size-3.5 text-muted-foreground" />
                <Select
                  value={repo.teamId ?? ""}
                  onChange={(e) => assign(repo.id, e.target.value)}
                  className="h-7 text-[11px]"
                  aria-label={`Team for ${repo.id}`}
                >
                  <option value="">nobody in particular</option>
                  {/* A team that no longer exists still names itself, rather than
                      reading as unowned in the one field that decides access. */}
                  {repo.teamId && !teams.some((t) => t.id === repo.teamId) && (
                    <option value={repo.teamId}>{repo.teamId} (unknown team)</option>
                  )}
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </label>
              <span className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => pull(repo.id)} disabled={repo.status === "installing"}>
                  <DownloadCloud className={cn(repo.status === "installing" && "animate-pulse")} />
                  Pull
                </Button>
                <Button variant="ghost" size="sm" onClick={() => reinstall(repo.id)} disabled={repo.status === "installing"}>
                  <RefreshCw className={cn(repo.status === "installing" && "animate-spin")} />
                  Re-run setup
                </Button>
                <Button variant="ghost" size="icon" onClick={() => forget(repo)} aria-label="Forget">
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            </div>

            <p className="break-all font-mono text-[11px] text-muted-foreground">{repo.root}</p>

            {assignError?.id === repo.id && <p className="text-[11px] text-destructive">{assignError.message}</p>}

            <div className="grid gap-2 text-[11px] sm:grid-cols-2">
              <div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">setup</span>
                <pre className="mt-0.5 whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono">
                  {toText(repo.setup) || "—"}
                </pre>
              </div>
              <div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">prepare</span>
                <pre className="mt-0.5 whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono">
                  {toText(repo.prepare) || "—"}
                </pre>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                Start a run with <code className="font-mono text-foreground/80">repo: {repo.id}</code>
              </span>
              {repo.publicationRemote ? (
                <span>
                  · publishes <code className="font-mono text-foreground/80">{repo.branchPolicy}</code> to{" "}
                  <code className="font-mono text-foreground/80">{repo.publicationRemote}</code>
                </span>
              ) : (
                <span>· does not publish: its run branches stay on the machine that made them</span>
              )}
              {repo.lastSetupLog && (
                <button
                  className="underline-offset-2 hover:underline"
                  onClick={() => setOpenLog(openLog === repo.id ? null : repo.id)}
                >
                  {openLog === repo.id ? "hide log" : "setup log"}
                </button>
              )}
            </div>

            {openLog === repo.id && repo.lastSetupLog && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 font-mono text-[11px]">
                {repo.lastSetupLog}
              </pre>
            )}
          </Card>
        ))}
      </div>
    </main>
  );
}
