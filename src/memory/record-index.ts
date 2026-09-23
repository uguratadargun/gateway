import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { getDb } from "@/lib/db";
import { loadSettings } from "@/lib/settings";
import { teamFamily, teamRoot } from "@/lib/teams";
import { listRepos, readRemote, repoByIdentity, type RepoRecord } from "@/repos/store";

import type { DocumentCard, HistoryCommit, HistoryResult, InterfaceCard, RepoRecordCard } from "./cards";
import { deleteEmbedding } from "./embeddings";
import {
  closeByRecord,
  decisionsAwaitingMerge,
  decisionsInRepo,
  getFeature,
  markMerged,
  recordTouchCheck,
  renameTouch,
  toMatchQuery,
  upsertFeature,
} from "./store";
import { SHIPPED_OUTCOMES, type MemoryScope } from "./types";

/**
 * The record index: what every connected repository says about itself, read
 * by code from its base branch. Commits are not copied in: the history of a
 * path is read from the checkout when it is asked for, at the commit the
 * index last read, with each commit's `Documents:` line.
 *
 * The repository's documents are the source — `docs/design/`, `docs/decisions/`,
 * `docs/specs/`, `docs/ARCHITECTURE.md` — and they have a form that code
 * checks, so reading them needs no model. Before this, memory saw a document
 * only when a run's own diff added it: a record edited on the base branch by
 * hand, a sibling team's design doc, a repository whose team never ran gate —
 * none of it existed for recall. The index reads all of it, on a timer and on
 * request, and is derived: every row here can be dropped and read again.
 *
 * The same read answers three questions about decisions recorded from runs,
 * each a fact about the base branch rather than a judgement:
 *
 * - **Did the work land?** A decision's head commit in the base branch's
 *   history, or the decision record the run wrote present on it, makes the
 *   decision `merged` — whatever the run reported when it ended.
 * - **Did its record move?** Two branches that took the same decision number
 *   are renumbered by hand; the decision's touch follows the record's slug to
 *   its new path.
 * - **Is its code still there?** A shipped decision whose every file is gone
 *   from the base branch describes code that no longer exists, and says so.
 */

const exec = promisify(execFile);

const FETCH_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
/** The ref the index fetches the base branch into, so a concurrent `ask` fetch cannot move it. */
const BASE_REF = "refs/gate/record/base";
/** One document is read whole up to this; a design doc is pages, not megabytes. */
const MAX_BODY_CHARS = 60_000;
/** Everything under docs/ is listed; `recordKindOf` says which files are record. */
const DOC_PATHS = ["docs"];
/** Past this many notes a repository's docs/ is an archive, not a record; the newest-named are kept. */
const MAX_NOTES = 400;

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function gitMessage(e: unknown): string {
  const err = e as Error & { stderr?: string };
  return (err.stderr || err.message || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
}

const SHA = /^[0-9a-f]{7,40}$/;

// ── Reading one document ─────────────────────────────────────────────────────

/**
 * The four kinds the convention names, and `note`: any other Markdown under
 * `docs/` — a design note written before the convention, a feature write-up
 * under a name of its own, a `superpowers` spec. Read so that a repository's
 * existing writing is found before anybody rewrites it into the convention;
 * never taken for a feature's page or a decision.
 */
export type RecordDocKind = "design" | "decision" | "spec" | "architecture" | "note";

export interface RecordInterface {
  role: "provides" | "consumes";
  name: string;
  note: string;
}

export interface ParsedRecordDoc {
  kind: RecordDocKind;
  slug: string;
  number: number | null;
  title: string;
  status: string | null;
  date: string | null;
  /** What a reader needs first: a design doc's Summary, a decision's Decision. */
  summary: string;
  /** A design doc's Pitfalls section: what a sibling building the same thing must not miss. */
  pitfalls: string;
  body: string;
  sections: Record<string, string>;
  interfaces: RecordInterface[];
}

/** Which kind of record a path is, by the convention's own file names; null for anything else. */
export function recordKindOf(path: string): { kind: RecordDocKind; slug: string; number: number | null; date: string | null } | null {
  if (path === "docs/ARCHITECTURE.md") return { kind: "architecture", slug: "architecture", number: null, date: null };
  let m = path.match(/^docs\/design\/([^/]+)\.md$/);
  if (m) return { kind: "design", slug: m[1], number: null, date: null };
  m = path.match(/^docs\/decisions\/(\d{4})-([^/]+)\.md$/);
  if (m) return { kind: "decision", slug: m[2], number: Number(m[1]), date: null };
  m = path.match(/^docs\/specs\/(\d{4}-\d{2}-\d{2})-([^/]+)\.md$/);
  if (m) return { kind: "spec", slug: m[2], number: null, date: m[1] };
  // The pipeline's scratch space is never the record, whatever is in it; and
  // a file under design/ or decisions/ that misses the convention's name is
  // a mistake in the record, not a note beside it.
  if (/^docs\/(plans|design|decisions)\//.test(path)) return null;
  m = path.match(/^docs\/(?:.+\/)?([^/]+)\.md$/i);
  if (m) return { kind: "note", slug: m[1].toLowerCase(), number: null, date: path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null };
  return null;
}

/**
 * The Interfaces section of a design doc: one line per thing the feature
 * offers other repositories or uses from them.
 *
 *   - provides: `POST /v1/sync` — the batch endpoint every client pushes to
 *   - consumes: sync.batch-accepted event — to clear the local queue
 */
export function parseInterfaces(section: string): RecordInterface[] {
  const out: RecordInterface[] = [];
  const seen = new Set<string>();
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\**(provides|consumes)\**\s*:?\**\s*(.+)$/i);
    if (!m) continue;
    const role = m[1].toLowerCase() as RecordInterface["role"];
    const rest = m[2].trim();
    const split = rest.match(/^(.+?)\s+(?:—|–|-{1,2})\s+(.*)$/);
    const name = (split ? split[1] : rest).replace(/`/g, "").trim();
    const note = (split ? split[2] : "").trim();
    if (!name) continue;
    const key = `${role}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name: name.slice(0, 200), note: note.slice(0, 500) });
  }
  return out;
}

/** A record document, read the way `scripts/check-docs.mjs` holds its form. */
export function parseRecordDoc(path: string, text: string): ParsedRecordDoc | null {
  const kind = recordKindOf(path);
  if (!kind) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const titleLine = lines.find((l) => /^#\s+/.test(l)) ?? "";
  let title = titleLine.replace(/^#\s+/, "").trim();
  if (kind.kind === "decision") title = title.replace(/^\d{4}\.\s*/, "");
  if (!title) title = kind.slug.replace(/-/g, " ");

  // The header: `Key: value` lines before the first section.
  const firstSection = lines.findIndex((l) => /^##\s+/.test(l));
  const head = (firstSection < 0 ? lines : lines.slice(0, firstSection)).join("\n");
  const header = (key: string) => head.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? null;

  const sections: Record<string, string> = {};
  let current: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current) sections[current] = buf.join("\n").trim();
    buf.length = 0;
  };
  for (const l of lines) {
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      current = h[1];
      continue;
    }
    if (current) buf.push(l);
  }
  flush();

  const firstParagraph = (s: string) => s.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^#/.test(p) && !/^\w+:\s/.test(p)) ?? "";
  let summary = "";
  if (kind.kind === "design" || kind.kind === "note") summary = sections.Summary ?? sections.Özet ?? firstParagraph(text);
  else if (kind.kind === "decision") summary = sections.Decision ?? "";
  else if (kind.kind === "spec") summary = firstParagraph(lines.slice(Math.max(firstSection, 0)).join("\n")) || firstParagraph(text);
  else summary = firstParagraph(text);

  return {
    kind: kind.kind,
    slug: kind.slug,
    number: kind.number,
    title: title.slice(0, 300),
    status: header("Status"),
    date: header("Date") ?? kind.date,
    summary: summary.slice(0, 2_000),
    pitfalls: kind.kind === "design" ? (sections.Pitfalls ?? "").slice(0, 2_000) : "",
    body: text.slice(0, MAX_BODY_CHARS),
    sections,
    interfaces: kind.kind === "design" ? parseInterfaces(sections.Interfaces ?? "") : [],
  };
}

/** Every path a commit body names on its `Documents:` lines. */
export function documentsLine(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^Documents:\s*(.+)$/gim)) {
    for (const p of m[1].split(/[,\s]+/)) {
      const path = p.replace(/[`'"]/g, "").trim();
      if (path && /\.md$/.test(path)) out.push(path);
    }
  }
  return [...new Set(out)];
}

// ── Indexing one repository ──────────────────────────────────────────────────

export interface IndexOutcome {
  repo: string;
  ok: boolean;
  commit?: string;
  ref?: string;
  /** Documents read because they were new or changed. */
  read?: number;
  removed?: number;
  /** Decisions promoted to merged by this read. */
  merged?: number;
  /** Decision touches moved to a renumbered record. */
  renamed?: number;
  /** Decisions whose every file is gone from the base branch. */
  stale?: number;
  /** Merges without a gate run, put in the recorder's ledger. */
  mergesRecorded?: number;
  error?: string;
}

/** The base branch as the repository's remote has it, fetched into the index's own ref. */
async function resolveBase(repo: RepoRecord): Promise<{ commit: string; ref: string } | { error: string }> {
  const remote = readRemote(repo);
  let ref = repo.baseRef?.trim() || "";
  if (!ref) {
    // The remote's default branch: `ref: refs/heads/main	HEAD`.
    try {
      const out = await git(repo.root, ["ls-remote", "--symref", remote, "HEAD"], FETCH_TIMEOUT_MS);
      ref = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? "";
    } catch {
      // Offline: the local copy of the remote's HEAD still names it.
      try {
        ref = (await git(repo.root, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])).trim().replace(`${remote}/`, "");
      } catch {
        ref = "";
      }
    }
  }
  if (!ref) return { error: `cannot tell which branch is the base of ${remote} — set a base ref on the Repos page` };
  try {
    await git(repo.root, ["fetch", "--no-tags", "--quiet", remote, `+${ref}:${BASE_REF}`], FETCH_TIMEOUT_MS);
  } catch (e) {
    // What was fetched before is still a true read of an older commit; an
    // index that stops on a network blip would tell recall nothing at all.
    const local = (await gitOk(repo.root, ["rev-parse", "--verify", "--quiet", BASE_REF])) ? BASE_REF : `refs/remotes/${remote}/${ref}`;
    try {
      const commit = (await git(repo.root, ["rev-parse", "--verify", `${local}^{commit}`])).trim();
      return { commit, ref };
    } catch {
      return { error: `could not fetch ${ref} from ${remote}: ${gitMessage(e)}` };
    }
  }
  const commit = (await git(repo.root, ["rev-parse", "--verify", `${BASE_REF}^{commit}`])).trim();
  return { commit, ref };
}

interface RepoState {
  commit_sha: string | null;
  merges_seen: string | null;
}

function repoState(repoKey: string): RepoState | null {
  return (getDb().prepare("SELECT commit_sha, merges_seen FROM record_repos WHERE repo = ?").get(repoKey) as RepoState | undefined) ?? null;
}

function writeRepoState(repo: RepoRecord, patch: { ref?: string | null; commit?: string | null; committedAt?: number | null; error?: string | null; mergesSeen?: string | null }, now: number): void {
  const db = getDb();
  const docs = (db.prepare("SELECT COUNT(*) AS n FROM record_docs WHERE repo = ?").get(repo.id) as { n: number }).n;
  db.prepare(
    `INSERT INTO record_repos (repo, repo_id, team_id, ref, commit_sha, committed_at, indexed_at, error, docs, merges_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo) DO UPDATE SET
       repo_id = excluded.repo_id, team_id = excluded.team_id,
       ref = COALESCE(excluded.ref, record_repos.ref),
       commit_sha = COALESCE(excluded.commit_sha, record_repos.commit_sha),
       committed_at = COALESCE(excluded.committed_at, record_repos.committed_at),
       indexed_at = excluded.indexed_at, error = excluded.error, docs = excluded.docs,
       merges_seen = COALESCE(excluded.merges_seen, record_repos.merges_seen)`,
  ).run(
    repo.id,
    repo.repoId,
    repo.teamId,
    patch.ref ?? null,
    patch.commit ?? null,
    patch.committedAt ?? null,
    now,
    patch.error ?? null,
    Number(docs),
    patch.mergesSeen ?? null,
  );
}

function deleteDoc(repoKey: string, path: string): void {
  const db = getDb();
  db.prepare("DELETE FROM record_docs WHERE repo = ? AND path = ?").run(repoKey, path);
  db.prepare("DELETE FROM record_docs_fts WHERE key = ?").run(`${repoKey}:${path}`);
  db.prepare("DELETE FROM record_interfaces WHERE repo = ? AND path = ?").run(repoKey, path);
  deleteEmbedding("doc", `${repoKey}:${path}`);
}

function writeDoc(repo: RepoRecord, path: string, blob: string, commit: string, doc: ParsedRecordDoc, now: number): void {
  const db = getDb();
  const key = `${repo.id}:${path}`;
  db.prepare(
    `INSERT INTO record_docs (repo, path, repo_id, team_id, kind, slug, number, title, status, date, summary, pitfalls, body, blob, commit_sha, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo, path) DO UPDATE SET
       repo_id = excluded.repo_id, team_id = excluded.team_id, kind = excluded.kind, slug = excluded.slug,
       number = excluded.number, title = excluded.title, status = excluded.status, date = excluded.date,
       summary = excluded.summary, pitfalls = excluded.pitfalls, body = excluded.body, blob = excluded.blob,
       commit_sha = excluded.commit_sha, indexed_at = excluded.indexed_at`,
  ).run(repo.id, path, repo.repoId, repo.teamId, doc.kind, doc.slug, doc.number, doc.title, doc.status, doc.date, doc.summary, doc.pitfalls, doc.body, blob, commit, now);
  db.prepare("DELETE FROM record_docs_fts WHERE key = ?").run(key);
  db.prepare("INSERT INTO record_docs_fts (key, title, summary, body, path) VALUES (?,?,?,?,?)").run(key, doc.title, doc.summary, doc.body, path);
  db.prepare("DELETE FROM record_interfaces WHERE repo = ? AND path = ?").run(repo.id, path);
  const ins = db.prepare("INSERT OR IGNORE INTO record_interfaces (repo, path, role, name, note) VALUES (?,?,?,?,?)");
  for (const i of doc.interfaces) ins.run(repo.id, path, i.role, i.name, i.note);
  deleteEmbedding("doc", key);
}

/**
 * A design doc is a feature's own page, and its file name is the feature's
 * id: `offline-sync.md` in the android repository and in the desktop one are
 * the same catalogue entry. A feature the catalogue does not have yet is
 * opened from the doc; one it has keeps its name and aliases.
 */
function linkFeature(repo: RepoRecord, design: { slug: string; title: string; summary: string }, now: number): void {
  if (!repo.teamId) return;
  const orgId = teamRoot(repo.teamId);
  const existing = getFeature(design.slug);
  if (existing && existing.orgId !== orgId) return;
  const line = design.summary.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  if (!existing) {
    upsertFeature({ id: design.slug, orgId, name: design.title, summary: line, now });
  } else if (!existing.summary && line) {
    upsertFeature({ id: existing.id, orgId, name: existing.name, summary: line, now });
  }
}

async function readDocs(repo: RepoRecord, commit: string, now: number): Promise<{ read: number; removed: number }> {
  const listing = await git(repo.root, ["ls-tree", "-r", commit, "--", ...DOC_PATHS]);
  const onBranch = new Map<string, string>();
  const notes: Array<[string, string]> = [];
  for (const line of listing.split("\n")) {
    const m = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
    const kind = m ? recordKindOf(m[2]) : null;
    if (!m || !kind) continue;
    if (kind.kind === "note") notes.push([m[2], m[1]]);
    else onBranch.set(m[2], m[1]);
  }
  // The newest-named first, where a docs/ holds years of dated write-ups.
  for (const [path, blob] of notes.sort((a, b) => b[0].localeCompare(a[0])).slice(0, MAX_NOTES)) onBranch.set(path, blob);
  const db = getDb();
  // A row read before the index kept a design doc's pitfalls, or before a
  // path counted as a note, is read again: same blob, less kept.
  const indexed = new Map(
    (
      db.prepare("SELECT path, blob, kind, pitfalls FROM record_docs WHERE repo = ?").all(repo.id) as Array<{ path: string; blob: string; kind: string; pitfalls: string | null }>
    ).map((r) => [r.path, r.kind === "design" && r.pitfalls == null ? "" : r.blob]),
  );
  let read = 0;
  let removed = 0;
  for (const [path, blob] of onBranch) {
    const same = indexed.get(path) === blob;
    // An unchanged document is not read again; its row still moves to this
    // commit, and a design doc still links its feature, which a team given
    // to the repository after the first read did not have then.
    if (same) {
      db.prepare("UPDATE record_docs SET commit_sha = ?, repo_id = ?, team_id = ? WHERE repo = ? AND path = ?").run(commit, repo.repoId, repo.teamId, repo.id, path);
      const kind = recordKindOf(path);
      if (kind?.kind === "design") {
        const row = db.prepare("SELECT title, summary FROM record_docs WHERE repo = ? AND path = ?").get(repo.id, path) as { title: string; summary: string };
        linkFeature(repo, { slug: kind.slug, title: row.title, summary: row.summary }, now);
      }
      continue;
    }
    const text = await git(repo.root, ["cat-file", "blob", blob]);
    const doc = parseRecordDoc(path, text);
    if (!doc) continue;
    writeDoc(repo, path, blob, commit, doc, now);
    if (doc.kind === "design") linkFeature(repo, doc, now);
    read++;
  }
  for (const path of indexed.keys()) {
    if (onBranch.has(path)) continue;
    deleteDoc(repo.id, path);
    removed++;
  }
  return { read, removed };
}

/** The commits a decision's work may be known by: its run's head, and what the run published. */
function commitsOfDecision(executionId: string, head: string | null, base: string | null): string[] {
  const row = getDb().prepare("SELECT published_commit FROM workflow_executions WHERE id = ?").get(executionId) as { published_commit: string | null } | undefined;
  // A run whose head is its base changed nothing — an investigation, a review
  // — and "its head is in the base branch" would be true of it trivially.
  return [head, row?.published_commit ?? null].filter((c): c is string => !!c && SHA.test(c) && c !== base);
}

async function reconcile(repo: RepoRecord, commit: string, committedAt: number): Promise<{ merged: number; renamed: number; stale: number }> {
  if (!repo.repoId) return { merged: 0, renamed: 0, stale: 0 };
  const db = getDb();
  const decisionDocs = db
    .prepare("SELECT path, slug, status FROM record_docs WHERE repo = ? AND kind = 'decision'")
    .all(repo.id) as Array<{ path: string; slug: string; status: string | null }>;
  const bySlug = new Map<string, string[]>();
  for (const d of decisionDocs) bySlug.set(d.slug, [...(bySlug.get(d.slug) ?? []), d.path]);
  const onBranch = new Set(decisionDocs.map((d) => d.path));

  // Renumbered records: the touch follows the slug, when exactly one record
  // on the base branch has it and the old path is not itself a record there.
  let renamed = 0;
  const refs = db
    .prepare("SELECT DISTINCT ref FROM memory_touches WHERE repo_id = ? AND ref LIKE 'docs/decisions/%'")
    .all(repo.repoId) as Array<{ ref: string }>;
  for (const { ref } of refs) {
    if (onBranch.has(ref)) continue;
    const kind = recordKindOf(ref);
    const target = kind?.kind === "decision" ? bySlug.get(kind.slug) : undefined;
    if (target?.length === 1) renamed += renameTouch(repo.repoId, ref, target[0]) ? 1 : 0;
  }

  // Records superseded on the base branch close the decisions written from them.
  for (const d of decisionDocs) {
    if (d.status && /^superseded/i.test(d.status)) closeByRecord(repo.repoId, d.path, committedAt);
  }

  // Work that landed.
  const merged: string[] = [];
  for (const d of decisionsAwaitingMerge(repo.repoId)) {
    let landed = false;
    for (const c of commitsOfDecision(d.executionId, d.headCommit, d.baseCommit)) {
      if ((await gitOk(repo.root, ["cat-file", "-e", `${c}^{commit}`])) && (await gitOk(repo.root, ["merge-base", "--is-ancestor", c, commit]))) {
        landed = true;
        break;
      }
    }
    // A squash merge leaves no commit of the branch in the base's history,
    // but it does leave the decision record the run wrote.
    if (!landed) {
      landed = d.touches.some((t) => {
        const kind = t.kind === "file" ? recordKindOf(t.ref) : null;
        return kind?.kind === "decision" && (bySlug.get(kind.slug)?.length ?? 0) > 0;
      });
    }
    if (landed) merged.push(d.id);
  }
  markMerged(merged);

  // Code that is gone: only for work that landed, since an open branch's new
  // files are not on the base branch yet and are not missing.
  let stale = 0;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const f of (await git(repo.root, ["ls-tree", "-r", "--name-only", commit])).split("\n")) {
    if (!f) continue;
    files.add(f);
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  }
  for (const d of decisionsInRepo(repo.repoId)) {
    if (!(SHIPPED_OUTCOMES as readonly string[]).includes(d.outcome)) continue;
    const fileTouches = d.touches.filter((t) => t.kind === "file").map((t) => t.ref.replace(/\/+$/, ""));
    if (!fileTouches.length) continue;
    const missing = fileTouches.filter((t) => !files.has(t) && !dirs.has(t)).length;
    if (missing !== d.missingTouches || d.checkedCommit !== commit) recordTouchCheck(d.id, commit, missing);
    if (missing === fileTouches.length) stale++;
  }
  return { merged: merged.length, renamed, stale };
}

const g = globalThis as unknown as { __gateRecordIndex?: Promise<IndexOutcome[]> | null };

/** Whether the last full read is older than `intervalMs` — the timer's question, answered from the table so a restart does not re-read at once. */
export function recordIndexDue(intervalMs: number, now = Date.now()): boolean {
  if (!listRepos().length) return false;
  const row = getDb().prepare("SELECT MIN(COALESCE(indexed_at, 0)) AS oldest, COUNT(*) AS n FROM record_repos").get() as { oldest: number | null; n: number };
  if (Number(row.n) < listRepos().length) return true;
  return now - Number(row.oldest ?? 0) >= intervalMs;
}

/**
 * Reads one repository's base branch into the index and reconciles the
 * decisions recorded about it. Never throws: an outcome says what happened,
 * and the repository's row carries the error for the Memory page.
 */
export async function indexRepo(repo: RepoRecord, opts: { now?: number } = {}): Promise<IndexOutcome> {
  const now = opts.now ?? Date.now();
  if (!repo.root || !existsSync(repo.root)) {
    const error = `the checkout at ${repo.root || "(no path)"} is not on this machine`;
    writeRepoState(repo, { error }, now);
    return { repo: repo.id, ok: false, error };
  }
  try {
    const base = await resolveBase(repo);
    if ("error" in base) {
      writeRepoState(repo, { error: base.error }, now);
      return { repo: repo.id, ok: false, error: base.error };
    }
    const committedAt = Number((await git(repo.root, ["show", "-s", "--format=%ct", base.commit])).trim()) * 1000;
    const previous = repoState(repo.id);
    const { read, removed } = await readDocs(repo, base.commit, now);
    const { merged, renamed, stale } = await reconcile(repo, base.commit, committedAt);
    let mergesRecorded = 0;
    let mergesSeen: string | null = previous?.merges_seen ?? null;
    if (loadSettings().memory.recordMerges) {
      // The first read only sets where merges start counting: recording a
      // repository's whole history is `/gate:teach`, done on purpose.
      if (mergesSeen) {
        const { recordMergesSince } = await import("./merges");
        mergesRecorded = await recordMergesSince(repo, mergesSeen, base.commit);
      }
      mergesSeen = base.commit;
    }
    writeRepoState(repo, { ref: base.ref, commit: base.commit, committedAt, error: null, mergesSeen }, now);
    return { repo: repo.id, ok: true, commit: base.commit, ref: base.ref, read, removed, merged, renamed, stale, mergesRecorded };
  } catch (e) {
    const error = gitMessage(e) || String(e);
    writeRepoState(repo, { error }, now);
    return { repo: repo.id, ok: false, error };
  }
}

/**
 * Every connected repository, one after another. One pass at a time per
 * process: a second ask while one is going waits for it and gets its answer.
 */
export function indexAllRepos(): Promise<IndexOutcome[]> {
  if (g.__gateRecordIndex) return g.__gateRecordIndex;
  const pass = (async () => {
    const out: IndexOutcome[] = [];
    for (const repo of listRepos()) out.push(await indexRepo(repo));
    return out;
  })().finally(() => {
    g.__gateRecordIndex = null;
  });
  g.__gateRecordIndex = pass;
  return pass;
}

// ── Reading the index ────────────────────────────────────────────────────────

export interface RecordDocHit {
  repo: string;
  repoId: string | null;
  teamId: string | null;
  path: string;
  kind: RecordDocKind;
  slug: string;
  number: number | null;
  title: string;
  status: string | null;
  date: string | null;
  summary: string;
  pitfalls: string;
  commit: string;
  score: number;
}

export function rowToDoc(r: any): RecordDocHit {
  return {
    pitfalls: r.pitfalls ?? "",
    repo: r.repo,
    repoId: r.repo_id ?? null,
    teamId: r.team_id ?? null,
    path: r.path,
    kind: r.kind,
    slug: r.slug,
    number: r.number == null ? null : Number(r.number),
    title: r.title,
    status: r.status ?? null,
    date: r.date ?? null,
    summary: r.summary ?? "",
    commit: r.commit_sha,
    score: r.rank == null ? 0 : -Number(r.rank),
  };
}

/**
 * Who may read a repository's record: its own team's tree. A repository no
 * team has claimed answers everyone, the same rule `ask` keeps — treating
 * unset as secret would hide every repository connected before teams did.
 */
function scopeWhere(scope: MemoryScope): { sql: string; params: unknown[] } {
  return { sql: `(d.team_id IS NULL OR d.team_id IN (${scope.teams.map(() => "?").join(",")}))`, params: [...scope.teams] };
}

export interface RecordDocSearch {
  query?: string;
  /** Code paths: documents that mention a path under one of these. */
  paths?: string[];
  /** The asker's repository: its documents rank first. */
  repoId?: string | null;
  kinds?: RecordDocKind[];
  limit?: number;
}

/** Documents in the scope's repositories, best first, the asker's own team and repository first. */
export function searchRecordDocs(scope: MemoryScope, search: RecordDocSearch): RecordDocHit[] {
  if (!scope.teams.length) return [];
  const limit = Math.min(Math.max(search.limit ?? 8, 1), 50);
  const { sql: scoped, params } = scopeWhere(scope);
  const where = [scoped];
  if (search.kinds?.length) {
    where.push(`d.kind IN (${search.kinds.map(() => "?").join(",")})`);
    params.push(...search.kinds);
  }
  const paths = (search.paths ?? []).map((p) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  if (paths.length) {
    // A design doc names the files it lives in under Key files, a decision
    // under Touches: the path in the body is the link. The asker's own
    // repository only — a path means nothing in another one.
    where.push(`(${paths.map(() => "instr(d.body, ?) > 0").join(" OR ")})`);
    params.push(...paths);
    if (search.repoId) {
      where.push("(d.repo_id IS NULL OR d.repo_id = ?)");
      params.push(search.repoId);
    }
  }
  const order = `(d.team_id = ?) DESC, (d.repo_id IS NOT NULL AND d.repo_id = ?) DESC`;
  const match = search.query ? toMatchQuery(search.query) : null;
  const db = getDb();
  if (match) {
    const rows = db
      .prepare(
        `SELECT d.*, bm25(record_docs_fts, 0, 10, 5, 1, 2) AS rank
           FROM record_docs_fts fts
           JOIN record_docs d ON (d.repo || ':' || d.path) = fts.key
          WHERE record_docs_fts MATCH ? AND ${where.join(" AND ")}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, ...params, limit * 3) as any[];
    // Relevance first; within a close field, the asker's own team and
    // repository — bm25 is the main signal and ownership only breaks ties.
    return rows
      .map(rowToDoc)
      .map((d) => ({ ...d, score: d.score * (d.teamId === scope.own ? 1.15 : 1) * (search.repoId && d.repoId === search.repoId ? 1.1 : 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  if (!paths.length && !search.kinds?.length) return [];
  const rows = db
    .prepare(`SELECT d.* FROM record_docs d WHERE ${where.join(" AND ")} ORDER BY ${order}, d.kind, d.path LIMIT ?`)
    .all(...params, scope.own, search.repoId ?? "", limit) as any[];
  return rows.map(rowToDoc);
}

export function toDocumentCard(d: RecordDocHit, interfaces?: RecordInterface[]): DocumentCard {
  return {
    repo: d.repo,
    repoId: d.repoId,
    team: d.teamId,
    path: d.path,
    kind: d.kind,
    title: d.title,
    status: d.status,
    date: d.date,
    summary: d.summary,
    ...(d.kind === "design" && d.pitfalls ? { pitfalls: d.pitfalls } : {}),
    commit: d.commit,
    ...(interfaces?.length
      ? { interfaces: interfaces.map((i) => ({ ...i, repo: d.repo, repoId: d.repoId, team: d.teamId, path: d.path, feature: d.slug })) }
      : {}),
  };
}

/** Every repository's design doc for one feature, in the scope. */
export function designDocsOf(scope: MemoryScope, featureId: string): Array<RecordDocHit & { interfaces: RecordInterface[] }> {
  if (!scope.teams.length) return [];
  const { sql, params } = scopeWhere(scope);
  const rows = getDb()
    .prepare(`SELECT d.* FROM record_docs d WHERE d.kind = 'design' AND d.slug = ? AND ${sql} ORDER BY (d.team_id = ?) DESC, d.repo`)
    .all(featureId, ...params, scope.own) as any[];
  return rows.map((r) => ({ ...rowToDoc(r), interfaces: interfacesOfDoc(r.repo, r.path) }));
}

function interfacesOfDoc(repo: string, path: string): RecordInterface[] {
  return getDb()
    .prepare("SELECT role, name, note FROM record_interfaces WHERE repo = ? AND path = ? ORDER BY role DESC, name")
    .all(repo, path) as unknown as RecordInterface[];
}

/**
 * Who provides and who consumes an interface, across the scope: the question
 * "if the server changes this, who has to follow, and how did each of them
 * integrate it". Matched on the name, case-insensitively, as a substring.
 */
export function interfaceUsers(scope: MemoryScope, name: string, limit = 50): InterfaceCard[] {
  const needle = name.trim().toLowerCase();
  if (!needle || !scope.teams.length) return [];
  const { sql, params } = scopeWhere(scope);
  return (
    getDb()
      .prepare(
        `SELECT i.name, i.role, i.note, d.repo, d.repo_id, d.team_id, d.path, d.slug
           FROM record_interfaces i JOIN record_docs d ON d.repo = i.repo AND d.path = i.path
          WHERE instr(lower(i.name), ?) > 0 AND ${sql}
          ORDER BY i.name, i.role DESC, (d.team_id = ?) DESC
          LIMIT ?`,
      )
      .all(needle, ...params, scope.own, limit) as any[]
  ).map((r) => ({ name: r.name, role: r.role, note: r.note, repo: r.repo, repoId: r.repo_id ?? null, team: r.team_id ?? null, path: r.path, feature: r.slug }));
}

/** Interfaces whose names the text mentions — what a task about "the sync endpoint" is about. */
export function interfacesMentioned(scope: MemoryScope, text: string, limit = 20): InterfaceCard[] {
  if (!scope.teams.length || !text.trim()) return [];
  const { sql, params } = scopeWhere(scope);
  const lower = text.toLowerCase();
  const rows = getDb()
    .prepare(
      `SELECT i.name, i.role, i.note, d.repo, d.repo_id, d.team_id, d.path, d.slug
         FROM record_interfaces i JOIN record_docs d ON d.repo = i.repo AND d.path = i.path
        WHERE ${sql}`,
    )
    .all(...params) as any[];
  return rows
    .filter((r) => String(r.name).length >= 4 && lower.includes(String(r.name).toLowerCase()))
    .slice(0, limit)
    .map((r) => ({ name: r.name, role: r.role, note: r.note, repo: r.repo, repoId: r.repo_id ?? null, team: r.team_id ?? null, path: r.path, feature: r.slug }));
}

/**
 * What changed under some paths on a repository's base branch, newest first:
 * the list a person bisects, with each commit's record and the gate run it
 * came from. Read from the checkout at the commit the index last read — not
 * fetched again, so it answers in a moment and is true of a named commit.
 *
 * Every commit, gate's or not: something broken by a hand-made commit is
 * exactly what a record of runs alone would never show.
 */
export async function historyOf(scope: MemoryScope, req: { repoId: string | null; paths: string[]; since?: number; limit?: number }): Promise<HistoryResult> {
  const empty = (unavailable: string, repo: RepoRecord | null = null): HistoryResult => ({
    repo: repo?.id ?? null,
    repoId: req.repoId,
    ref: null,
    commit: null,
    commits: [],
    unavailable,
  });
  if (!req.repoId) return empty("say which repository: history is read from one repository's base branch");
  const repo = repoByIdentity(req.repoId);
  if (!repo || (repo.teamId && !teamFamily(scope.own).includes(repo.teamId))) {
    return empty(`gate has no repository called "${req.repoId}" connected on the server — connect it on the Repos page to read its history`);
  }
  const state = getDb().prepare("SELECT ref, commit_sha FROM record_repos WHERE repo = ?").get(repo.id) as { ref: string | null; commit_sha: string | null } | undefined;
  if (!state?.commit_sha) return empty(`"${repo.id}" has not been read yet — the record index reads it on its next pass, or press Read now on Memory`, repo);
  const limit = Math.min(Math.max(req.limit ?? 30, 1), 200);
  const args = ["log", "--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e", "-n", String(limit)];
  if (req.since != null) args.push(`--since=${Math.floor(req.since / 1000)}`);
  args.push(state.commit_sha);
  const paths = req.paths.map((p) => p.trim().replace(/^\.\//, "")).filter(Boolean);
  if (paths.length) args.push("--", ...paths);
  let out = "";
  try {
    out = await git(repo.root, args);
  } catch (e) {
    return empty(`could not read the history of "${repo.id}": ${gitMessage(e)}`, repo);
  }
  const commits: HistoryCommit[] = [];
  const runOf = getDb().prepare(
    `SELECT id FROM workflow_executions
      WHERE repo_id = ? AND (published_commit = ? OR json_extract(workspace_json, '$.commit') = ?)`,
  );
  for (const rec of out.split("\x1e")) {
    const [sha, ct, author, subject, body] = rec.replace(/^\n+/, "").split("\x1f");
    if (!sha || !SHA.test(sha)) continue;
    const runs = (runOf.all(req.repoId, sha, sha) as Array<{ id: string }>).map((r) => r.id);
    const fromBranch = (body ?? "").match(/gate\/run-([0-9a-f]{8})/)?.[1] ?? subject?.match(/gate\/run-([0-9a-f]{8})/)?.[1];
    if (fromBranch && !runs.some((r) => r.startsWith(fromBranch))) runs.push(fromBranch);
    commits.push({
      sha,
      date: new Date(Number(ct) * 1000).toISOString(),
      author: author ?? "",
      subject: subject ?? "",
      documents: documentsLine(body ?? ""),
      runs,
    });
  }
  return { repo: repo.id, repoId: req.repoId, ref: state.ref, commit: state.commit_sha, commits, unavailable: null };
}

export interface RecordRepoStatus {
  repo: string;
  repoId: string | null;
  teamId: string | null;
  ref: string | null;
  commit: string | null;
  committedAt: number | null;
  indexedAt: number | null;
  error: string | null;
  docs: number;
}

/** Where every connected repository's index stands, for the Memory page. */
export function recordIndexStatus(): RecordRepoStatus[] {
  const rows = getDb().prepare("SELECT * FROM record_repos").all() as any[];
  const byRepo = new Map(rows.map((r) => [r.repo, r]));
  return listRepos().map((repo) => {
    const r = byRepo.get(repo.id);
    return {
      repo: repo.id,
      repoId: repo.repoId,
      teamId: repo.teamId,
      ref: r?.ref ?? null,
      commit: r?.commit_sha ?? null,
      committedAt: r?.committed_at ?? null,
      indexedAt: r?.indexed_at ?? null,
      error: r?.error ?? null,
      docs: Number(r?.docs ?? 0),
    };
  });
}

/**
 * Whether a repository is one the gate reads, for the person standing in its
 * checkout: `/gate:init` asks before it writes documents nobody would read.
 * Outside the asker's family it is answered as not connected, in the same
 * words a repository nobody connected gets.
 */
export function repoRecordFor(scope: MemoryScope, repoId: string | null): RepoRecordCard {
  const none = (advice: string): RepoRecordCard => ({
    repoId,
    connected: false,
    repo: null,
    team: null,
    ref: null,
    commit: null,
    indexedAt: null,
    error: null,
    documents: {},
    advice,
  });
  if (!repoId) return none("the checkout has no remote the gate can name — give it an origin, then connect it on the Repos page");
  const repo = repoByIdentity(repoId);
  if (!repo || (repo.teamId && !teamFamily(scope.own).includes(repo.teamId))) {
    return none(`connect ${repoId} on the gate's Repos page, with its team, so its record is read`);
  }
  const db = getDb();
  const state = db.prepare("SELECT ref, commit_sha, indexed_at, error FROM record_repos WHERE repo = ?").get(repo.id) as
    | { ref: string | null; commit_sha: string | null; indexed_at: number | null; error: string | null }
    | undefined;
  const documents: RepoRecordCard["documents"] = {};
  for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM record_docs WHERE repo = ? GROUP BY kind").all(repo.id) as Array<{ kind: RecordDocKind; n: number }>) {
    documents[r.kind] = Number(r.n);
  }
  return {
    repoId,
    connected: true,
    repo: repo.id,
    team: repo.teamId,
    ref: state?.ref ?? null,
    commit: state?.commit_sha ?? null,
    indexedAt: state?.indexed_at ? new Date(state.indexed_at).toISOString() : null,
    error: state?.error ?? null,
    documents,
    advice: repo.teamId ? null : "give it a team on the Repos page: without one, every team on the gate reads it",
  };
}

