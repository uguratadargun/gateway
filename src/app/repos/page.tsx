"use client";

import { useEffect, useState } from "react";
import { DownloadCloud, FolderGit2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Connected repositories: where a run's worktree comes from, and what has to
 * happen before one can be worked in.
 *
 * The commands are shown, not hidden behind a spinner — they are guessed from
 * the lockfile and the guess is often nearly right, so the useful thing is to
 * put it in front of you before it runs rather than after it fails.
 */

interface Repo {
  id: string;
  name: string;
  source: string;
  root: string;
  cloned: boolean;
  baseRef: string | null;
  setup: string[][];
  prepare: string[][];
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
  const [source, setSource] = useState("");
  const [setup, setSetup] = useState("");
  const [prepare, setPrepare] = useState("");
  const [detected, setDetected] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "detect" | "connect">(null);
  const [error, setError] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/repos");
    if (r.ok) setRepos((await r.json()).repos);
  }
  useEffect(() => {
    load();
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
      body: JSON.stringify({ source, setup: toArgv(setup), prepare: toArgv(prepare) }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) return setError(data.error ?? "could not connect that repository");
    setSource("");
    setSetup("");
    setPrepare("");
    // Connecting a URL is the first time anything is known about it, so say
    // what the clone turned up rather than clearing the line to nothing.
    setDetected(data.detected?.reason ? `connected · detected from ${data.detected.reason}` : null);
    load();
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
    if (!confirm(`Forget "${repo.id}"?\n\nThe checkout at ${repo.root} is left on disk.`)) return;
    await fetch(`/api/repos/${repo.id}`, { method: "DELETE" });
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
