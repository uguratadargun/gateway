"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FolderGit2, GitBranch, Loader2, Play } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Starting a run: which repository, which pipeline, and what to do.
 *
 * Those were three different places before — a path typed into a free-text
 * field on the workflow page, with nothing to say whether it existed or had
 * ever been installed. The repository is now picked from the ones that are
 * connected and ready, so the first thing a run can fail on is the work rather
 * than the setup.
 */

interface ApiWorkflow {
  id: string;
  name: string;
  description?: string;
  nodes: Array<{ id: string }>;
  workspace?: { repo?: string } | null;
  inputs: string[];
}

interface ApiRepo {
  id: string;
  name: string;
  root: string;
  status: "new" | "installing" | "ready" | "failed";
}

/** The one input every hand-written pipeline uses, and the one worth a big box. */
const TASK = "task";

export default function NewExecutionPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [repos, setRepos] = useState<ApiRepo[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [repo, setRepo] = useState("");
  const [task, setTask] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((d) => setWorkflows(d.workflows ?? []))
      .catch(() => setError("could not load workflows"));
    fetch("/api/repos")
      .then((r) => r.json())
      .then((d) => setRepos(d.repos ?? []))
      .catch(() => undefined);
  }, []);

  const workflow = workflows.find((w) => w.id === workflowId) ?? null;
  const needsRepo = Boolean(workflow?.workspace);

  // A pinned repo is a default, not a rule: the same pipeline is worth aiming
  // at another project without editing it.
  useEffect(() => {
    setRepo(workflow?.workspace?.repo ?? "");
    setExtra({});
  }, [workflowId, workflow?.workspace?.repo]);

  /** Everything the workflow needs beyond the task and the repository. */
  const otherInputs = useMemo(
    () => (workflow?.inputs ?? []).filter((k) => k !== TASK && k !== "repo"),
    [workflow],
  );

  const chosenRepo = repos.find((r) => r.id === repo);
  const repoBlocked = needsRepo && chosenRepo && chosenRepo.status !== "ready";
  const ready = Boolean(workflowId) && (!needsRepo || Boolean(repo)) && !repoBlocked && task.trim().length > 0;

  async function start() {
    setStarting(true);
    setError(null);
    const input: Record<string, string> = { [TASK]: task.trim(), ...extra };
    if (needsRepo && repo) input.repo = repo;
    const r = await fetch("/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId, input }),
    });
    const data = await r.json();
    if (!r.ok) {
      setStarting(false);
      setError(data.error ?? "could not start the run");
      return;
    }
    router.push(`/executions/${data.executionId}`);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-8">
      <header className="flex items-center gap-3">
        <Link href="/executions">
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">New run</h1>
          <p className="text-xs text-muted-foreground">Pick a pipeline and a repository, then say what to do.</p>
        </div>
      </header>

      <Card className="space-y-2 p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">workflow</div>
        {workflows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No workflows yet.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => setWorkflowId(w.id)}
                className={cn(
                  "rounded-md border p-2 text-left transition-colors hover:bg-muted/50",
                  workflowId === w.id && "border-primary bg-muted/60",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs font-medium">{w.id}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{w.nodes.length} nodes</span>
                </div>
                {w.description && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{w.description}</p>}
              </button>
            ))}
          </div>
        )}
      </Card>

      {needsRepo && (
        <Card className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">repository</div>
            <Link href="/repos" className="text-[10px] text-muted-foreground underline-offset-2 hover:underline">
              manage
            </Link>
          </div>
          {repos.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing connected. <Link href="/repos" className="underline underline-offset-2">Connect one</Link>, or type
              an absolute path below.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {repos.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRepo(r.id)}
                  className={cn(
                    "rounded-md border p-2 text-left transition-colors hover:bg-muted/50",
                    repo === r.id && "border-primary bg-muted/60",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs font-medium">{r.id}</span>
                    {r.status !== "ready" && (
                      <Badge variant={r.status === "failed" ? "destructive" : "outline"} className="ml-auto text-[10px]">
                        {r.status}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{r.root}</p>
                </button>
              ))}
            </div>
          )}
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="or an absolute path"
            spellCheck={false}
            className="h-8 font-mono text-xs"
          />
          {repoBlocked && (
            <p className="text-xs text-destructive">
              &ldquo;{repo}&rdquo; has not finished its setup — run it from the Repos page first.
            </p>
          )}
        </Card>
      )}

      <Card className="space-y-2 p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">task</div>
        <Textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="What should this run do?"
          className="h-32 resize-none text-sm"
        />
        {otherInputs.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {otherInputs.map((k) => (
              <label key={k} className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</span>
                <Input
                  value={extra[k] ?? ""}
                  onChange={(e) => setExtra((p) => ({ ...p, [k]: e.target.value }))}
                  className="h-8 text-xs"
                />
              </label>
            ))}
          </div>
        )}
      </Card>

      {error && <p className="px-1 text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={start} disabled={!ready || starting}>
          {starting ? <Loader2 className="animate-spin" /> : <Play />}
          {starting ? "Starting…" : "Start run"}
        </Button>
        {workflow?.workspace && (
          <span className="text-[11px] text-muted-foreground">
            Runs in a fresh git worktree; your checkout is untouched.
          </span>
        )}
      </div>
    </main>
  );
}
