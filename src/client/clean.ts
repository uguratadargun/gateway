import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isFullyPushed, releaseRunWorkspace, removeRunWorkspace } from "@/runtime/workspace";

import type { GateClient } from "./api";
import { gateHome } from "./config";
import { forgetRun } from "./step";

/**
 * `gate clean`: the worktrees runs left behind, and what to do with each.
 *
 * A run's worktree goes when the run ends, its branch keeping the work. What
 * is still here is from before that, or from a run that never got to end on
 * this machine — a session closed mid-run, a server that wrote it off — and
 * those were measured at gigabytes each. So this lists them with what git and
 * the server say about each, and removes every one whose run the server says
 * is not running: what it left uncommitted is committed onto its branch
 * first, exactly as a run ending does. A worktree the server has no record of
 * goes only when it plainly holds nothing that could be lost — fully pushed,
 * or nothing past its base — unless `--all` says to take it anyway, the same
 * way. The branch is kept in every case, so `git checkout <branch>` brings
 * back everything.
 */

export type WorkspaceVerdict = "running" | "pushed" | "empty" | "unpushed" | "dirty" | "unknown";

export interface WorkspaceEntry {
  executionId: string;
  root: string;
  repo: string | null;
  branch: string | null;
  /** The commit the run's branch was cut from, when the server still knows the run. */
  baseCommit: string | null;
  /** What the server says the run is, or "unknown" when it has no record of it. */
  status: string;
  verdict: WorkspaceVerdict;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Where the worktree's repository is, from git itself — the run may be gone from the server. */
function repoOf(root: string): string | null {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  return common.endsWith("/.git") ? common.slice(0, -5) : common;
}

/** What one worktree holds, judged from its own git state. */
export function judgeWorkspace(root: string, baseCommit?: string | null): Exclude<WorkspaceVerdict, "running" | "unknown"> {
  if (git(root, ["rev-parse", "--git-dir"]) === null) return "dirty";
  const dirty = (git(root, ["status", "--porcelain"]) ?? "x").length > 0;
  if (dirty) return "dirty";
  if (isFullyPushed(root)) return "pushed";
  // Nothing committed past the base: the run produced nothing that could be lost.
  if (baseCommit && git(root, ["rev-list", "--count", `${baseCommit}..HEAD`]) === "0") return "empty";
  return "unpushed";
}

export async function listWorkspaces(client: Pick<GateClient, "execution">): Promise<WorkspaceEntry[]> {
  const dir = join(gateHome(), "workspaces");
  if (!existsSync(dir)) return [];
  const out: WorkspaceEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(dir, entry.name);
    let status = "unknown";
    let baseCommit: string | null = null;
    let branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let repo = repoOf(root);
    try {
      const { execution } = await client.execution(entry.name);
      status = String(execution.status);
      baseCommit = execution.workspace?.baseCommit ?? null;
      branch = execution.workspace?.branch ?? branch;
      repo = execution.workspace?.repo ?? repo;
    } catch {
      // Deleted from the history, or a gate that cannot be reached: the
      // worktree is judged on what git says alone.
    }
    const verdict: WorkspaceVerdict = status === "running" ? "running" : judgeWorkspace(root, baseCommit);
    out.push({ executionId: entry.name, root, repo, branch, baseCommit, status, verdict });
  }
  return out;
}

export interface CleanResult {
  removed: WorkspaceEntry[];
  kept: WorkspaceEntry[];
}

/** Which of the listed worktrees go, under the rule above. */
export function planClean(entries: WorkspaceEntry[], all: boolean): CleanResult {
  const removed: WorkspaceEntry[] = [];
  const kept: WorkspaceEntry[] = [];
  for (const e of entries) {
    const ended = e.status !== "unknown";
    const goes = e.verdict !== "running" && (all || ended || e.verdict === "pushed" || e.verdict === "empty");
    (goes ? removed : kept).push(e);
  }
  return { removed, kept };
}

/**
 * Removes what the plan says — committing what each left uncommitted onto its
 * branch first — and drops the run's own files, except for a failed run,
 * whose `gate continue` still needs them. Returns a line for each worktree
 * that stayed after all.
 */
export function applyClean(plan: CleanResult): string[] {
  const notes: string[] = [];
  for (const e of plan.removed) {
    if (e.repo && e.branch) {
      const ws = { repo: e.repo, root: e.root, branch: e.branch, baseRef: "", baseCommit: e.baseCommit ?? undefined };
      const released = releaseRunWorkspace(ws, e.executionId);
      // Not a worktree git knows: nothing in it can be committed, so it is only a directory.
      if (released === null && existsSync(e.root)) removeRunWorkspace(ws, { keepBranch: true });
    } else {
      removeRunWorkspace({ repo: e.root, root: e.root, branch: "" }, { keepBranch: true });
    }
    if (existsSync(e.root)) {
      notes.push(`kept ${e.executionId.slice(0, 8)}: its worktree could not be removed, or what it left uncommitted could not be committed`);
      continue;
    }
    if (e.status !== "failed") forgetRun(e.executionId);
  }
  return notes;
}

export function describeVerdict(v: WorkspaceVerdict): string {
  switch (v) {
    case "running":
      return "running — kept";
    case "pushed":
      return "every commit is on the remote";
    case "empty":
      return "nothing was produced";
    case "unpushed":
      return "has commits not on any remote — they stay on its branch";
    case "dirty":
      return "has uncommitted changes — committed onto its branch before it goes";
    default:
      return "unknown";
  }
}
