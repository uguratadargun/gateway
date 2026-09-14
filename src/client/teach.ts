import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { teachAccountSchema, type TeachAccount, type TeachCommit } from "@/lib/client-api-schemas";

/**
 * `gate teach`: the git half. Works out which stretch of history is the
 * task — the commits between where the branch was cut and where it ended —
 * and reads what the recorder is shown beside the session's account of it.
 *
 * All of it is read from the repository, never asked for: the base is the
 * default branch's fork point, or, for work that was already merged, the
 * point the merge brought it in from. `--base` is for the history neither
 * finds (a fast-forward, a branch cut from another branch).
 */

export class TeachError extends Error {}

export interface BranchReading {
  repo: string;
  /** The branch's name, or `HEAD@<sha>` for a detached checkout of old work. */
  branch: string;
  /** What the base was worked out from, as the person would name it. */
  baseRef: string;
  baseCommit: string;
  head: string;
  /** The merge on `baseRef` that brought the work in, when it was already merged. */
  mergedBy: string | null;
  commits: TeachCommit[];
  /** Commits past the cap, left out of `commits`. */
  omittedCommits: number;
  changedFiles: string[];
  stat: string;
  /** Uncommitted changes in the checkout, which are not part of what is taught. */
  dirty: boolean;
  startedAt: number;
  finishedAt: number;
}

const MAX_COMMITS = 500;
const MAX_FILES = 200;
const MAX_DIFF_BYTES = 4_000_000;

function git(cwd: string, args: string[]): string {
  // trimEnd, not trim: `--stat` indents its first line, and that is alignment.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function isAncestor(cwd: string, ancestor: string, of: string): boolean {
  return tryGit(cwd, ["merge-base", "--is-ancestor", ancestor, of]) !== null;
}

/** The branch work is merged into here: origin's HEAD, else the usual names. */
function defaultBase(repo: string): string {
  const originHead = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead;
  for (const name of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(repo, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])) return name;
  }
  throw new TeachError("cannot tell which branch this work was cut from — pass --base <branch or commit>");
}

/**
 * For work already merged: the first merge on `baseTip`'s own line whose
 * first parent did not yet have `head`. Its first parent is where the base
 * stood when the work came in, so the fork point against it is the start.
 */
function mergeThatBroughtIn(repo: string, head: string, baseTip: string): { merge: string; base: string } | null {
  const merges = tryGit(repo, ["rev-list", "--first-parent", "--merges", "--ancestry-path", "--reverse", `${head}..${baseTip}`]);
  for (const merge of (merges ?? "").split("\n").filter(Boolean)) {
    const firstParent = git(repo, ["rev-parse", `${merge}^1`]);
    if (!isAncestor(repo, head, firstParent)) return { merge, base: git(repo, ["merge-base", firstParent, head]) };
  }
  return null;
}

export function readBranch(cwd: string, base?: string): BranchReading {
  const repo = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repo) throw new TeachError(`${cwd} is not a git repository — run it from the checkout the work is in`);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const name = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = name === "HEAD" ? `HEAD@${head.slice(0, 12)}` : name;

  const baseRef = base ?? defaultBase(repo);
  const baseTip = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (!baseTip) throw new TeachError(`no such branch or commit: ${baseRef}`);

  let baseCommit = isAncestor(repo, baseTip, head) ? baseTip : git(repo, ["merge-base", baseTip, head]);
  let mergedBy: string | null = null;
  if (baseCommit === head) {
    const found = mergeThatBroughtIn(repo, head, baseTip);
    if (found) {
      baseCommit = found.base;
      mergedBy = found.merge;
    }
  }
  if (baseCommit === head) {
    throw new TeachError(
      `${branch} is already part of ${baseRef} with no merge commit to tell where it began — ` +
        "pass --base <the commit the work started from>",
    );
  }

  const log = git(repo, ["log", "--reverse", "--no-merges", "--format=%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e", `${baseCommit}..${head}`]);
  const all = log
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, date, author, subject, body = ""] = r.split("\x1f");
      return { sha, date, author: author.slice(0, 200), subject: subject.slice(0, 1000), body: body.trim().slice(0, 4000) };
    });
  if (!all.length) throw new TeachError(`no commits of its own between ${baseCommit.slice(0, 8)} and ${head.slice(0, 8)}, only merges`);

  const changed = git(repo, ["diff", "--name-only", baseCommit, head]).split("\n").filter(Boolean);
  const finishedAt = Date.parse(git(repo, ["log", "-1", "--format=%cI", head]));
  return {
    repo,
    branch,
    baseRef,
    baseCommit,
    head,
    mergedBy,
    commits: all.slice(0, MAX_COMMITS),
    omittedCommits: Math.max(0, all.length - MAX_COMMITS),
    changedFiles: changed.slice(0, MAX_FILES),
    stat: git(repo, ["diff", "--stat=120", baseCommit, head]),
    dirty: git(repo, ["status", "--porcelain"]) !== "",
    startedAt: Date.parse(all[0].date),
    finishedAt,
  };
}

export function readBranchDiff(r: BranchReading): string {
  const diff = git(r.repo, ["diff", r.baseCommit, r.head]);
  return diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) : diff;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What `gate teach` prints before anything is taught: the range, and how to read it. */
export function describeBranch(r: BranchReading): string {
  const range = `${r.baseCommit.slice(0, 8)}..${r.head.slice(0, 8)}`;
  const count = r.commits.length + r.omittedCommits;
  const lines = [
    `branch  ${r.branch} (HEAD ${r.head.slice(0, 8)}) in ${r.repo}`,
    `base    ${r.baseRef} → ${r.baseCommit.slice(0, 8)}${r.mergedBy ? ` · merged into ${r.baseRef} by ${r.mergedBy.slice(0, 8)}` : ""}`,
    `range   ${range} · ${count} commit${count === 1 ? "" : "s"} · ${r.changedFiles.length} file${r.changedFiles.length === 1 ? "" : "s"} · ${day(r.startedAt)} → ${day(r.finishedAt)}`,
  ];
  if (r.dirty) lines.push("note    this checkout has uncommitted changes; they are not part of what is taught");
  lines.push("", "commits, oldest first:");
  for (const c of r.commits) {
    lines.push(`  ${c.sha.slice(0, 8)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.subject}`);
    for (const line of c.body.split("\n").filter(Boolean).slice(0, 8)) lines.push(`      ${line}`);
  }
  if (r.omittedCommits) lines.push(`  … and ${r.omittedCommits} more`);
  lines.push("", "files:", r.stat, "", `read the work with: git log -p --reverse ${range}   ·   git diff ${range} -- <path>`);
  return lines.join("\n");
}

/** The session's account, checked here so a wrong field is named before anything is sent. */
export function readAccount(file: string): TeachAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new TeachError(`cannot read ${file} as JSON: ${(e as Error).message}`);
  }
  const parsed = teachAccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TeachError(
      `${file} is not an account gate can teach:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n"),
    );
  }
  return parsed.data;
}
