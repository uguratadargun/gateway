import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export interface RunWorkspace {
  /** Absolute path the tools are confined to. */
  root: string;
  repo: string;
  branch: string;
  baseRef: string;
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
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10_000_000 }).trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new WorkflowError("WORKSPACE_ERROR", `git ${args[0]} failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
  }
}

/** Creates the run's worktree. Throws before any node runs if it cannot. */
export function createRunWorkspace(spec: WorkspaceSpec, executionId: string): RunWorkspace {
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
  return { root, repo, branch, baseRef };
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

/** Removes a worktree and its branch. Only ever called explicitly. */
export function removeRunWorkspace(ws: { repo: string; root: string; branch: string }): void {
  try {
    git(ws.repo, ["worktree", "remove", "--force", ws.root]);
  } catch {
    rmSync(ws.root, { recursive: true, force: true });
  }
  try {
    git(ws.repo, ["branch", "-D", ws.branch]);
  } catch {
    // The branch may already be gone, or checked out elsewhere.
  }
}
