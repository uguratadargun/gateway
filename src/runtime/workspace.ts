import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { linkedDirectories } from "@/repos/detect";

import { WorkflowError } from "./errors";
import type { WorkspaceSpec } from "@/workflows/types";

/**
 * Per-run workspaces.
 *
 * A workflow that touches a repository never works in the repository itself:
 * each run gets its own `git worktree` on its own branch under
 * ~/.gate/workspaces/<executionId>. Agents write there, tests run there, and
 * the user's checkout and current branch are untouched no matter what the
 * agents do. The worktree is left behind on purpose — it is the deliverable.
 */

/** A workspace spec with its repository settled — pinned, or given per run. */
export type ResolvedWorkspaceSpec = Omit<WorkspaceSpec, "repo"> & { repo: string };

export interface RunWorkspace {
  /** Absolute path the tools are confined to. */
  root: string;
  repo: string;
  branch: string;
  baseRef: string;
  /**
   * The commit the branch was cut from — `baseRef` resolved at creation. A
   * run's agents commit as they go, so "what did the run do" is the working
   * tree against this, not against the index. Optional only because runs
   * recorded before it existed have no such field.
   */
  baseCommit?: string;
}

export interface WorkspaceSummary extends RunWorkspace {
  /** Paths changed by the run, from `git status --porcelain` (capped). */
  changedFiles: string[];
  commit: string | null;
}

const MAX_LISTED_FILES = 200;

function workspacesDir(): string {
  return join(process.env.GATE_HOME || join(homedir(), ".gate"), "workspaces");
}

function git(cwd: string, args: string[]): string {
  try {
    // stderr piped, not inherited: a probe that is expected to fail — "no
    // upstream configured", asked of every worktree `gate clean` judges —
    // would otherwise print git's fatal line over the command's own output.
    // Piped, it still reaches the error's message for the failures that matter.
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10_000_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new WorkflowError("WORKSPACE_ERROR", `git ${args[0]} failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
  }
}

/** Creates the run's worktree. Throws before any node runs if it cannot. */
export function createRunWorkspace(spec: ResolvedWorkspaceSpec, executionId: string): RunWorkspace {
  const repo = resolve(spec.repo.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(repo)) {
    throw new WorkflowError("WORKSPACE_ERROR", `workspace repo "${spec.repo}" does not exist`);
  }
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new WorkflowError("WORKSPACE_ERROR", `workspace repo "${spec.repo}" is not a git repository`);
  }

  const baseRef = spec.baseRef ?? "HEAD";
  const branch = `${spec.branchPrefix ?? "gate/run"}-${executionId.slice(0, 8)}`;
  const root = join(workspacesDir(), executionId);
  mkdirSync(workspacesDir(), { recursive: true, mode: 0o700 });
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });

  git(repo, ["worktree", "add", "-b", branch, root, baseRef]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  return { root, repo, branch, baseRef, baseCommit };
}

/**
 * Lends the checkout's installed dependencies to a fresh worktree.
 *
 * A worktree carries what git tracks and nothing else, so `node_modules`,
 * `.venv` and `vendor` are not in it — and the first thing a planner following
 * its worktree skill then does is a full install, on the developer's own
 * machine, per run (measured here: 1.6 GB and a quarter of an hour, for a
 * result identical to the directory next door). A symlink is what the server's
 * own worktree preparation does too; a directory already present is left as
 * it is, so calling this twice is harmless. Returns what was linked.
 */
export function borrowDependencies(ws: Pick<RunWorkspace, "repo" | "root">): string[] {
  const linked: string[] = [];
  for (const dir of linkedDirectories(ws.repo)) {
    const target = join(ws.root, dir);
    if (existsSync(target)) continue;
    try {
      symlinkSync(join(ws.repo, dir), target, "dir");
      linked.push(dir);
    } catch (e) {
      throw new WorkflowError("WORKSPACE_ERROR", `could not link ${dir} into the worktree: ${(e as Error).message}`);
    }
  }
  return linked;
}

/** Whether a worktree's every commit is on its upstream and its tree is clean. */
export function isFullyPushed(root: string): boolean {
  try {
    if (git(root, ["status", "--porcelain"]).length) return false;
    // No upstream at all throws: nothing was pushed.
    git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    return git(root, ["rev-list", "--count", "@{upstream}..HEAD"]) === "0";
  } catch {
    return false;
  }
}

/**
 * What a finished run leaves behind on disk, tidied.
 *
 * A worktree is the deliverable while the work is only here; once every
 * commit is on the remote and the tree is clean, it is a copy of something
 * git already holds — and worktrees that are never removed were measured at
 * a dozen per repository and gigabytes. So a completed run whose branch is
 * fully pushed loses its worktree and keeps its branch: `git checkout
 * <branch>` brings the work back, and the merge request points at the same
 * commits. Anything unpushed or uncommitted stays exactly where it is.
 * Returns what happened, for the person to read; never throws.
 */
export function tidyRunWorkspace(ws: RunWorkspace): string | null {
  if (!existsSync(ws.root)) return null;
  if (!isFullyPushed(ws.root)) return null;
  try {
    removeRunWorkspace(ws, { keepBranch: true });
    return `worktree ${ws.root} removed: every commit is on the remote, and branch ${ws.branch} keeps the work`;
  } catch {
    return null;
  }
}

/** What the run left behind, recorded on the execution for the UI. */
export function summarizeWorkspace(ws: RunWorkspace): WorkspaceSummary {
  let changedFiles: string[] = [];
  let commit: string | null = null;
  try {
    changedFiles = git(ws.root, ["status", "--porcelain"])
      .split("\n")
      .filter(Boolean)
      .slice(0, MAX_LISTED_FILES)
      .map((l) => l.trim());
    commit = git(ws.root, ["rev-parse", "HEAD"]);
  } catch {
    // A summary is reporting, not correctness: never fail a run over it.
  }
  return { ...ws, changedFiles, commit };
}

/** A diff big enough to be a denial of service against the browser is not a diff. */
const MAX_DIFF_BYTES = 4_000_000;

/**
 * The unified diff of what a run did in its worktree, for the UI to render.
 *
 * `add -N` first, because a run's most interesting output is usually a file
 * that did not exist before and `git diff` alone cannot see one. It records
 * intent-to-add only — no content is staged — and it is the same thing the
 * pipeline's own `stage` node does.
 *
 * Against the base commit when the run recorded one: the shipped agents'
 * skills commit task by task, and a diff against the index would show a
 * finished run as empty. That is also what the pipeline's own `diff` node
 * does, so a diff read here matches the diff the reviewers were given.
 */
export function readRunDiff(root: string, baseCommit?: string): { diff: string; truncated: boolean } {
  if (!existsSync(root)) throw new WorkflowError("WORKSPACE_ERROR", "this run's worktree is gone");
  git(root, ["add", "-N", "."]);
  const diff = git(root, baseCommit ? ["diff", baseCommit] : ["diff"]);
  return diff.length > MAX_DIFF_BYTES
    ? { diff: diff.slice(0, MAX_DIFF_BYTES), truncated: true }
    : { diff, truncated: false };
}

/**
 * Removes a worktree, and its branch unless told to keep it. Only ever
 * called explicitly, or by `tidyRunWorkspace` for a branch that is on the
 * remote in full.
 */
export function removeRunWorkspace(ws: { repo: string; root: string; branch: string }, opts: { keepBranch?: boolean } = {}): void {
  try {
    git(ws.repo, ["worktree", "remove", "--force", ws.root]);
  } catch {
    rmSync(ws.root, { recursive: true, force: true });
    try {
      // The registration outlives a directory removed by hand.
      git(ws.repo, ["worktree", "prune"]);
    } catch {
      // Nothing to prune, or no repository left to ask.
    }
  }
  if (opts.keepBranch) return;
  try {
    git(ws.repo, ["branch", "-D", ws.branch]);
  } catch {
    // The branch may already be gone, or checked out elsewhere.
  }
}
