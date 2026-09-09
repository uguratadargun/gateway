import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isFullyPushed, removeRunWorkspace } from "@/runtime/workspace";

import type { GateClient } from "./api";
import { gateHome } from "./config";
import { forgetRun } from "./step";

/**
 * `gate clean`: the worktrees runs left behind, and what to do with each.
 *
 * A run's worktree is its deliverable while the work is only there, and
 * nothing removes it on the run's behalf except a completed run whose
 * commits are all on the remote. Everything else accumulates — measured
 * here as thirteen worktrees of one repository, twelve of them dead, near
 * three gigabytes — and nobody wants to work out by hand which of them still
 * hold something. So this lists them with what git and the server say about
 * each, and removes the ones that are plainly done: not running, and either
 * fully pushed or holding nothing at all. `--all` removes every worktree
 * whose run is not running, dirty or not; the branch is kept in every case,
 * so `git checkout <branch>` brings back anything that was committed.
 */

export type WorkspaceVerdict = "running" | "pushed" | "empty" | "unpushed" | "dirty" | "unknown";

export interface WorkspaceEntry {
  executionId: string;
  root: string;
  repo: string | null;
  branch: string | null;
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
    out.push({ executionId: entry.name, root, repo, branch, status, verdict });
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
    const goes = e.verdict !== "running" && (all || e.verdict === "pushed" || e.verdict === "empty");
    (goes ? removed : kept).push(e);
  }
  return { removed, kept };
}

/** Removes what the plan says, keeping every branch; also drops the run's own files. */
export function applyClean(plan: CleanResult): void {
  for (const e of plan.removed) {
    if (e.repo && e.branch) removeRunWorkspace({ repo: e.repo, root: e.root, branch: e.branch }, { keepBranch: true });
    else removeRunWorkspace({ repo: e.root, root: e.root, branch: "" }, { keepBranch: true });
    forgetRun(e.executionId);
  }
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
      return "has commits not on any remote — kept unless --all";
    case "dirty":
      return "has uncommitted changes — kept unless --all";
    default:
      return "unknown";
  }
}
