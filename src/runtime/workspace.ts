import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { LINKED_DIRECTORIES, linkedDirectories } from "@/repos/detect";

import { WorkflowError } from "./errors";
import type { WorkspaceSpec } from "@/workflows/types";

/**
 * Per-run workspaces.
 *
 * A workflow that touches a repository never works in the repository itself:
 * each run gets its own `git worktree` on its own branch under
 * ~/.gate/workspaces/<executionId>. Agents write there, tests run there, and
 * the user's checkout and current branch are untouched no matter what the
 * agents do. The branch is the deliverable: when the run ends the worktree
 * goes and the branch keeps the work (`releaseRunWorkspace`).
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

/**
 * What this checkout calls the place it came from.
 *
 * Only `origin`, and only as git itself resolves it — `remote.<name>.pushurl`
 * and `url.<base>.insteadOf` rewrites included, since the rewritten form is
 * the one that names the real host. A checkout with no remote answers null,
 * which is an honest answer: it is a repository, just not one another machine
 * has been told how to reach.
 *
 * Lives here rather than beside the repo records because the CLI needs it
 * too, and nothing in a client should have to open the server's database to
 * ask a checkout where it came from.
 */
export function readRemoteUrl(root: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    return url || null;
  } catch {
    return null;
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

/** Whether `path` is a symlink — how a borrowed dependency directory looks in a worktree. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether git ignores `path` in the worktree at `root`. */
function isIgnored(root: string, path: string): boolean {
  try {
    git(root, ["check-ignore", "-q", "--", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits whatever the run left uncommitted onto its own branch.
 *
 * A worktree only goes once the branch holds everything in it, so nothing is
 * lost with the directory. The borrowed dependency links are left out — they
 * point at the checkout next door, and a `node_modules/` ignore rule does not
 * match a symlink. Hooks are skipped: this is a snapshot, not a change someone
 * is proposing, and a pre-commit lint must not decide whether it is kept.
 */
function commitLeftovers(ws: Pick<RunWorkspace, "root" | "branch">, executionId: string): boolean {
  if (!git(ws.root, ["status", "--porcelain"]).length) return false;
  // Only a link nothing ignores yet: git refuses an exclude that names an ignored path.
  const excluded = LINKED_DIRECTORIES.filter((d) => isSymlink(join(ws.root, d)) && !isIgnored(ws.root, d)).map((d) => `:(exclude)${d}`);
  git(ws.root, ["add", "-A", "--", ".", ...excluded]);
  if (!git(ws.root, ["diff", "--cached", "--name-only"]).length) return false;
  let identity: string[] = [];
  try {
    git(ws.root, ["config", "user.email"]);
  } catch {
    // No identity configured anywhere: the commit would be refused over it.
    identity = ["-c", "user.name=gate", "-c", "user.email=gate@localhost"];
  }
  git(ws.root, [...identity, "commit", "--no-verify", "-q", "-m", `gate: what run ${executionId.slice(0, 8)} left uncommitted when it ended`]);
  return true;
}

/**
 * What a run leaves behind on disk once it has ended, removed.
 *
 * Worktrees that outlive their run were measured at gigabytes each — a
 * worktree gets its own `node_modules` the moment an agent installs — and
 * they piled up with every run, so a run's worktree does not outlive it.
 * The branch is the deliverable, not the directory: whatever the run left
 * uncommitted is committed onto it first, then the worktree goes and the
 * branch stays — `git checkout <branch>` or `git diff <base>..<branch>` in
 * the checkout brings all of it back, and `restoreRunWorkspace` rebuilds the
 * worktree when a run is continued. A branch with nothing on it past its
 * base goes too. If the leftovers cannot be committed, the worktree stays
 * exactly as it is. Returns what happened, for the person to read; never throws.
 */
export function releaseRunWorkspace(ws: RunWorkspace, executionId: string): string | null {
  if (!existsSync(ws.root)) return null;
  try {
    // Not a worktree git knows — nothing here to judge, so nothing is removed.
    if (git(ws.root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  } catch {
    return null;
  }
  let committed: boolean;
  try {
    committed = commitLeftovers(ws, executionId);
  } catch (e) {
    return `worktree ${ws.root} kept: what the run left uncommitted could not be committed onto ${ws.branch} (${(e as Error).message})`;
  }
  let empty = false;
  try {
    empty = !!ws.baseCommit && git(ws.root, ["rev-list", "--count", `${ws.baseCommit}..HEAD`]) === "0";
  } catch {
    // Unknown is not empty: keep the branch.
  }
  try {
    removeRunWorkspace(ws, { keepBranch: !empty });
  } catch (e) {
    return `worktree ${ws.root} could not be removed: ${(e as Error).message}`;
  }
  if (empty) return `worktree ${ws.root} removed: the run changed nothing, so branch ${ws.branch} went with it`;
  return `worktree ${ws.root} removed; branch ${ws.branch} keeps the work${committed ? " (what was uncommitted is its last commit)" : ""}`;
}

/**
 * Brings back the worktree of a run that ended, so it can be continued.
 *
 * The inverse of `releaseRunWorkspace`: the branch holds everything the run
 * did, so the worktree is checked out from it again at the same path — or,
 * for a run whose branch went because it held nothing, cut fresh from the
 * base commit. Returns false when the worktree is already there; throws a
 * WorkflowError when it cannot be brought back.
 */
export function restoreRunWorkspace(ws: RunWorkspace): boolean {
  if (existsSync(ws.root)) return false;
  if (!existsSync(ws.repo)) {
    throw new WorkflowError("WORKSPACE_ERROR", `the repository this run worked in (${ws.repo}) is gone`);
  }
  mkdirSync(dirname(ws.root), { recursive: true, mode: 0o700 });
  try {
    // The registration outlives a directory removed by hand.
    git(ws.repo, ["worktree", "prune"]);
  } catch {
    // Nothing to prune.
  }
  let hasBranch = true;
  try {
    git(ws.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`]);
  } catch {
    hasBranch = false;
  }
  if (hasBranch) {
    git(ws.repo, ["worktree", "add", ws.root, ws.branch]);
  } else if (ws.baseCommit) {
    git(ws.repo, ["worktree", "add", "-b", ws.branch, ws.root, ws.baseCommit]);
  } else {
    throw new WorkflowError("WORKSPACE_ERROR", `branch ${ws.branch} is gone, and the run recorded no base commit to cut it from again`);
  }
  return true;
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
 *
 * A run that ended has no worktree any more; its branch holds everything it
 * did, so given the repository and branch the diff is read from there.
 */
export function readRunDiff(
  root: string,
  baseCommit?: string,
  ended?: { repo: string; branch: string },
): { diff: string; truncated: boolean } {
  let diff: string;
  if (existsSync(root)) {
    git(root, ["add", "-N", "."]);
    diff = git(root, baseCommit ? ["diff", baseCommit] : ["diff"]);
  } else if (ended && baseCommit && existsSync(ended.repo)) {
    try {
      diff = git(ended.repo, ["diff", baseCommit, `refs/heads/${ended.branch}`]);
    } catch {
      throw new WorkflowError("WORKSPACE_ERROR", `this run's worktree is gone, and so is its branch ${ended.branch}`);
    }
  } else {
    throw new WorkflowError("WORKSPACE_ERROR", "this run's worktree is gone");
  }
  return diff.length > MAX_DIFF_BYTES
    ? { diff: diff.slice(0, MAX_DIFF_BYTES), truncated: true }
    : { diff, truncated: false };
}

/**
 * Removes a worktree, and its branch unless told to keep it. Whatever is
 * uncommitted in it goes with it: `releaseRunWorkspace` is the caller that
 * commits that first.
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
