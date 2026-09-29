import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { getDb } from "@/lib/db";
import { teamFamily } from "@/lib/teams";
import { isFullCommit } from "@/repos/refs";
import { getRepo, type RepoRecord } from "@/repos/store";

import type { AskSource } from "./ask";

/**
 * Another team's code at one commit, read by the asker's own machine.
 *
 * The server holds the checkout and fixes the commit; the reading is done by
 * the asker's Claude Code session, on their own login. What crosses between
 * the two is this: an ask, named by an id, and three read-only questions about
 * its commit — which files, which lines match, what one file says. Nothing is
 * checked out for it and nothing can be written through it: every answer is
 * `git ls-tree`, `git grep` or `git show` against the one commit the ask
 * names, in the server's own checkout.
 *
 * Every read checks again what creating the ask checked: that the ask is the
 * asker's team's, that it has not expired, and that the repository is still in
 * the asker's family. A repository moved to another company between the ask
 * and the read is not readable because an id was handed out an hour earlier.
 */

/** How long an ask can be read: long enough for any review, short enough to not be a standing grant. */
export const ASK_TTL_MS = 24 * 60 * 60_000;

const MAX_LIST_ENTRIES = 500;
const MAX_MATCHES = 100;
const MAX_READ_BYTES = 200_000;
const GIT_TIMEOUT_MS = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".turbo"]);

export interface AskRecord {
  id: string;
  teamId: string;
  userId: string | null;
  /** The connected repository's own id. */
  repo: string;
  repoId: string | null;
  ref: string;
  commit: string;
  question: string;
  createdAt: number;
  expiresAt: number;
}

export class AskReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function rowToAsk(r: any): AskRecord {
  return {
    id: r.id,
    teamId: r.team_id,
    userId: r.user_id ?? null,
    repo: r.repo,
    repoId: r.repo_id ?? null,
    ref: r.ref,
    commit: r.commit_sha,
    question: r.question,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export function createAsk(source: AskSource, question: string, asker: { teamId: string; userId: string | null }, now = Date.now()): AskRecord {
  const ask: AskRecord = {
    id: randomBytes(8).toString("hex"),
    teamId: asker.teamId,
    userId: asker.userId,
    repo: source.repo.id,
    repoId: source.repoId,
    ref: source.ref,
    commit: source.commit,
    question,
    createdAt: now,
    expiresAt: now + ASK_TTL_MS,
  };
  const db = getDb();
  // Expired asks are nobody's any more; cleared as new ones are made.
  db.prepare("DELETE FROM asks WHERE expires_at < ?").run(now);
  db.prepare(
    "INSERT INTO asks (id, team_id, user_id, repo, repo_id, ref, commit_sha, question, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(ask.id, ask.teamId, ask.userId, ask.repo, ask.repoId, ask.ref, ask.commit, ask.question, ask.createdAt, ask.expiresAt);
  return ask;
}

/**
 * The ask and its repository, if this team may read it now.
 *
 * Every refusal is a 404 with the same words, whatever the reason: whether an
 * id exists for somebody else is not something to confirm by the shape of a
 * refusal.
 */
export function openAsk(id: string, teamId: string, now = Date.now()): { ask: AskRecord; repo: RepoRecord } {
  const row = getDb().prepare("SELECT * FROM asks WHERE id = ?").get(id);
  const ask = row ? rowToAsk(row) : null;
  const gone = new AskReadError(`no ask "${id}" — asks expire after a day; ask again`, 404);
  // The commit is handed to `git ls-tree`, `git grep` and `git show` as it is,
  // so an ask whose commit is not a full object name is not read at all.
  if (!ask || ask.teamId !== teamId || ask.expiresAt < now || !isFullCommit(ask.commit)) throw gone;
  const repo = getRepo(ask.repo);
  if (!repo) throw gone;
  if (repo.teamId && !teamFamily(teamId).includes(repo.teamId)) throw gone;
  return { ask, repo };
}

/**
 * A path inside the repository, as git's pathspec reads it: relative, with no
 * way up and no magic. Git would not leave the tree for `..` in any case; this
 * refuses it rather than trusting that.
 */
function cleanPath(raw: unknown): string {
  const p = typeof raw === "string" ? raw.trim().replace(/^\.\/+/, "").replace(/\/+$/, "") : "";
  if (p === "" || p === ".") return "";
  if (p.startsWith("/") || p.startsWith(":") || p.split("/").some((part) => part === ".." || part === "")) {
    throw new AskReadError(`"${raw}" is not a path in the repository`, 400);
  }
  return p;
}

function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, maxBuffer });
}

/** Files and directories under `path` at the ask's commit, a level at a time, the way `list_files` lists a worktree. */
export function askTree(ask: AskRecord, repo: RepoRecord, rawPath: unknown, rawDepth: unknown): string {
  const path = cleanPath(rawPath);
  const asked = rawDepth === null || rawDepth === undefined || rawDepth === "" ? NaN : Number(rawDepth);
  const depth = Math.max(0, Math.min(12, Number.isFinite(asked) ? asked : 2));
  let out: string;
  try {
    out = git(repo.root, ["ls-tree", "-r", "-t", "--name-only", ask.commit, "--", ...(path ? [path] : [])]);
  } catch (e) {
    throw new AskReadError(`could not list ${path || "the root"}: ${(e as Error).message.split("\n")[0]}`, 400);
  }
  const prefix = path ? `${path}/` : "";
  const all = out.split("\n").filter(Boolean);
  const dirs = new Set<string>();
  for (const entry of all) {
    const parts = entry.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: string[] = [];
  let cut = false;
  for (const entry of all.sort()) {
    if (!entry.startsWith(prefix) || entry === path) continue;
    const rest = entry.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.some((part) => SKIP_DIRS.has(part))) continue;
    if (parts.length - 1 > depth) continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      cut = true;
      break;
    }
    entries.push(entry + (dirs.has(entry) ? "/" : ""));
  }
  if (!entries.length) return path ? `no such directory at ${ask.commit.slice(0, 12)}: ${path}` : "(empty)";
  return entries.join("\n") + (cut ? `\n… [listing stopped at ${MAX_LIST_ENTRIES} entries — list a subdirectory]` : "");
}

/** Lines matching a regular expression at the ask's commit, as `path:line:text`. */
export function askGrep(ask: AskRecord, repo: RepoRecord, rawPattern: unknown, rawPath: unknown, rawExt: unknown): string {
  const pattern = typeof rawPattern === "string" ? rawPattern : "";
  if (!pattern) throw new AskReadError('"pattern" is required', 400);
  const path = cleanPath(rawPath);
  const ext = typeof rawExt === "string" && /^\.?[A-Za-z0-9]{1,12}$/.test(rawExt.trim()) ? rawExt.trim().replace(/^\./, "") : "";
  const spec = ext ? `${path ? `${path}/` : ""}*.${ext}` : path;
  let out = "";
  try {
    // -e keeps a pattern that starts with a dash a pattern; -I skips binaries.
    out = git(repo.root, ["grep", "-n", "-I", "-E", "-e", pattern, ask.commit, "--", ...(spec ? [spec] : [])]);
  } catch (e) {
    const err = e as { status?: number; stderr?: string; message: string };
    // git grep exits 1 for "nothing matched", which is an answer.
    if (err.status === 1 && !err.stderr) return "no matches";
    throw new AskReadError(`search failed: ${(err.stderr || err.message).split("\n")[0]}`, 400);
  }
  const lead = `${ask.commit}:`;
  const lines = out.split("\n").filter(Boolean).map((l) => (l.startsWith(lead) ? l.slice(lead.length) : l));
  if (!lines.length) return "no matches";
  const shown = lines.slice(0, MAX_MATCHES).map((l) => (l.length > 500 ? `${l.slice(0, 500)}…` : l));
  return shown.join("\n") + (lines.length > MAX_MATCHES ? `\n… [${lines.length - MAX_MATCHES} more matches — narrow the pattern or the path]` : "");
}

/** One file at the ask's commit, with 1-based line numbers, the way `read_file` reads one. */
export function askFile(ask: AskRecord, repo: RepoRecord, rawPath: unknown, rawOffset: unknown, rawLimit: unknown): string {
  const path = cleanPath(rawPath);
  if (!path) throw new AskReadError('"path" is required', 400);
  let raw: string;
  try {
    raw = git(repo.root, ["show", `${ask.commit}:${path}`]);
  } catch {
    throw new AskReadError(`no such file at ${ask.commit.slice(0, 12)}: ${path}`, 404);
  }
  if (raw.startsWith("tree ")) throw new AskReadError(`"${path}" is a directory; list it instead`, 400);
  const lines = raw.split("\n");
  const offset = Math.max(1, Number(rawOffset || 1) || 1);
  const limit = Math.max(1, Number(rawLimit || lines.length) || lines.length);
  const numbered = lines
    .slice(offset - 1, offset - 1 + limit)
    .map((l, i) => `${offset + i}\t${l}`)
    .join("\n");
  return numbered.length > MAX_READ_BYTES
    ? `${numbered.slice(0, MAX_READ_BYTES)}\n… [file truncated at ${MAX_READ_BYTES} characters — read on with offset]`
    : numbered;
}
