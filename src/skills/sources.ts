import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "@/lib/db";
import { gateHome, type DefinitionScope } from "@/lib/def-root";
import { WorkflowError } from "@/runtime/errors";

import { parseSkill, skillSha, withSkillName } from "./loader";
import { resolveSkillDir, skillsDir, writeOrigin } from "./registry";
import { SKILL_ID_RE, type SkillOrigin } from "./types";

/**
 * Skill libraries gate can pull from, and what pulling one means.
 *
 * The skills worth having are mostly written elsewhere — `superpowers` is the
 * reason this exists — and the two obvious ways to use them are both wrong.
 * Vendoring a copy means the version you got is the version you keep, and
 * nobody notices upstream fixing the skill that has been misfiring for a month.
 * Reading straight from a clone means a run's behaviour changes the moment
 * someone else pushes, which is not something a pipeline should discover on a
 * Friday.
 *
 * So: a clone gate controls, and an import that is a deliberate act. Syncing
 * fetches; importing copies named skills into a team's library and stamps each
 * one with the commit it came from. Nothing changes what an agent runs until
 * somebody asks for it, and because the stamp is kept, "is this still the
 * upstream version" and "has someone edited it here" are both answerable.
 */

export type SkillSourceStatus = "new" | "syncing" | "ready" | "failed";

export interface SkillSourceRecord {
  id: string;
  name: string;
  url: string;
  ref: string | null;
  subdir: string;
  prefix: string;
  root: string;
  headSha: string | null;
  status: SkillSourceStatus;
  lastSyncAt: number | null;
  lastSyncLog: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  url: string;
  ref: string | null;
  subdir: string;
  prefix: string;
  root: string;
  head_sha: string | null;
  status: string;
  last_sync_at: number | null;
  last_sync_log: string | null;
  created_at: number;
}

const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_LOG_BYTES = 40_000;

/**
 * The library gate ships knowing about.
 *
 * Registered, not cloned: a fresh install should not spend a network round
 * trip on a repository nobody has asked for yet. It appears on the Skills page
 * with nothing pulled, and one Sync is the whole of getting it.
 */
const BUILT_IN: Array<Omit<SkillSourceRecord, "root" | "headSha" | "status" | "lastSyncAt" | "lastSyncLog" | "createdAt">> = [
  {
    id: "superpowers",
    name: "Superpowers",
    url: "https://github.com/obra/superpowers.git",
    ref: null,
    subdir: "skills",
    prefix: "superpowers-",
  },
];

export function sourcesDir(): string {
  return join(gateHome(), "skill-sources");
}

function toRecord(r: Row): SkillSourceRecord {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    ref: r.ref,
    subdir: r.subdir,
    prefix: r.prefix,
    root: r.root,
    headSha: r.head_sha,
    status: (["new", "syncing", "ready", "failed"] as const).includes(r.status as SkillSourceStatus)
      ? (r.status as SkillSourceStatus)
      : "new",
    lastSyncAt: r.last_sync_at,
    lastSyncLog: r.last_sync_log,
    createdAt: r.created_at,
  };
}

/** Seeds the built-in libraries once, so deleting one sticks. */
export function ensureBuiltInSources(): void {
  const db = getDb();
  const seeded = db.prepare("SELECT value FROM kv WHERE key = 'skill_sources_seeded'").get() as { value: string } | undefined;
  if (seeded) return;
  for (const s of BUILT_IN) {
    if (getSource(s.id)) continue;
    createSource(s);
  }
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('skill_sources_seeded', '1')").run();
}

export function listSources(): SkillSourceRecord[] {
  ensureBuiltInSources();
  return (getDb().prepare("SELECT * FROM skill_sources ORDER BY created_at ASC").all() as unknown as Row[]).map(toRecord);
}

export function getSource(id: string): SkillSourceRecord | null {
  const r = getDb().prepare("SELECT * FROM skill_sources WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toRecord(r) : null;
}

export interface NewSkillSource {
  id: string;
  name: string;
  url: string;
  ref?: string | null;
  subdir?: string;
  prefix?: string;
}

export function createSource(input: NewSkillSource): SkillSourceRecord {
  if (!SKILL_ID_RE.test(input.id)) {
    throw new WorkflowError("WORKSPACE_ERROR", "invalid source id (use lowercase letters, digits and dashes)");
  }
  if (getSource(input.id)) throw new WorkflowError("WORKSPACE_ERROR", `a skill source called "${input.id}" already exists`);
  getDb()
    .prepare(
      `INSERT INTO skill_sources (id, name, url, ref, subdir, prefix, root, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    )
    .run(
      input.id,
      input.name.trim() || input.id,
      input.url.trim(),
      input.ref?.trim() || null,
      (input.subdir ?? "skills").replace(/^\/+|\/+$/g, "") || ".",
      input.prefix ?? "",
      join(sourcesDir(), input.id),
      Date.now(),
    );
  return getSource(input.id)!;
}

export function deleteSource(id: string): boolean {
  const source = getSource(id);
  if (!source) return false;
  // The clone is gate's own, so it goes with the record. Skills already
  // imported from it are the team's and stay — with their provenance, which
  // then points at a source that is gone, and says so rather than lying.
  rmSync(source.root, { recursive: true, force: true });
  return getDb().prepare("DELETE FROM skill_sources WHERE id = ?").run(id).changes > 0;
}

function setStatus(id: string, status: SkillSourceStatus, log?: string, headSha?: string | null): void {
  getDb()
    .prepare("UPDATE skill_sources SET status = ?, last_sync_at = ?, last_sync_log = ?, head_sha = COALESCE(?, head_sha) WHERE id = ?")
    .run(status, Date.now(), log?.slice(-MAX_LOG_BYTES) ?? null, headSha ?? null, id);
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: "pipe" });
}

/**
 * Clone the library, or bring an existing clone up to date.
 *
 * Discarding rather than merging: this checkout is gate's copy of somebody
 * else's repository and is never edited here, so a reset to the remote is
 * always what was meant — and a clone that could end up half-merged would make
 * every import after it ambiguous.
 */
export function syncSource(id: string): SkillSourceRecord | null {
  const source = getSource(id);
  if (!source) return null;
  setStatus(id, "syncing");
  const log: string[] = [];
  try {
    if (!existsSync(join(source.root, ".git"))) {
      rmSync(source.root, { recursive: true, force: true });
      mkdirSync(sourcesDir(), { recursive: true, mode: 0o700 });
      log.push(git(["clone", ...(source.ref ? ["--branch", source.ref] : []), source.url, source.root]));
    } else {
      log.push(git(["remote", "set-url", "origin", source.url], source.root));
      log.push(git(["fetch", "--prune", "origin"], source.root));
      const target = source.ref ? `origin/${source.ref}` : git(["symbolic-ref", "refs/remotes/origin/HEAD"], source.root).trim().replace("refs/remotes/", "");
      log.push(git(["checkout", "--force", "--detach", target], source.root));
    }
    const head = git(["rev-parse", "HEAD"], source.root).trim();
    const dir = skillsRootOf(source);
    if (!existsSync(dir)) {
      setStatus(id, "failed", `${log.join("\n")}\n-> "${source.subdir}" is not a directory in this repository`, head);
      return getSource(id);
    }
    const found = availableSkills(source).length;
    setStatus(id, "ready", `${log.join("\n").trim()}\n-> ${found} skill(s) at ${source.subdir}, HEAD ${head.slice(0, 12)}`, head);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    setStatus(id, "failed", `${log.join("\n")}\n-> ${(err.stderr || err.message).trim()}`);
  }
  return getSource(id);
}

function skillsRootOf(source: SkillSourceRecord): string {
  return source.subdir === "." ? source.root : join(source.root, source.subdir);
}

export interface AvailableSkill {
  /** The directory it has upstream. */
  sourceSkill: string;
  /** The id it would get here, prefix included. */
  id: string;
  name: string;
  description: string;
  sha: string;
  /** Why the file could not be read, when it could not. */
  error?: string;
}

/** What the clone currently holds. Empty until the source has been synced. */
export function availableSkills(source: SkillSourceRecord): AvailableSkill[] {
  const root = skillsRootOf(source);
  if (!existsSync(root)) return [];
  const out: AvailableSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const id = `${source.prefix}${entry.name}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const raw = readFileSync(file, "utf8");
    try {
      const parsed = parseSkill(id, raw, { dir, sourcePath: file, updatedAt: statSync(file).mtimeMs });
      out.push({ sourceSkill: entry.name, id, name: parsed.name, description: parsed.description, sha: skillSha(raw) });
    } catch (e) {
      // Listed anyway: a library with one malformed skill should not look empty.
      out.push({ sourceSkill: entry.name, id, name: entry.name, description: "", sha: skillSha(raw), error: (e as Error).message });
    }
  }
  return out;
}

export type ImportState = "new" | "current" | "outdated" | "edited";

/**
 * Where an available skill stands against the team's library.
 *
 * `edited` outranks `outdated` deliberately: a skill somebody changed here is
 * one an update would overwrite, and that is the fact worth putting in front of
 * them before they press the button.
 */
export function importState(available: AvailableSkill, scope: DefinitionScope): ImportState {
  const dir = resolveSkillDir(available.id, scope);
  if (!dir) return "new";
  let origin: SkillOrigin | null = null;
  try {
    origin = JSON.parse(readFileSync(join(dir, ".gate-source.json"), "utf8")) as SkillOrigin;
  } catch {
    return "edited";
  }
  const onDisk = skillSha(readFileSync(join(dir, "SKILL.md"), "utf8"));
  if (onDisk !== origin.sha) return "edited";
  return origin.sha === available.sha ? "current" : "outdated";
}

export interface ImportResult {
  imported: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Copy named skills out of the clone and into a team's library.
 *
 * The whole directory, not just SKILL.md: a skill that points at a script or a
 * reference beside it is a skill that only works with them, and importing half
 * of one produces prose that tells an agent to open a file that is not there.
 */
export function importSkills(sourceId: string, sourceSkills: string[], scope: DefinitionScope, replace = false): ImportResult {
  const source = getSource(sourceId);
  if (!source) throw new WorkflowError("WORKSPACE_ERROR", `no skill source called "${sourceId}"`);
  const available = new Map(availableSkills(source).map((s) => [s.sourceSkill, s]));
  const root = skillsRootOf(source);
  const result: ImportResult = { imported: [], skipped: [] };

  for (const wanted of sourceSkills) {
    const skill = available.get(wanted);
    if (!skill) {
      result.skipped.push({ id: wanted, reason: "not in this source — sync it first" });
      continue;
    }
    if (skill.error) {
      result.skipped.push({ id: skill.id, reason: skill.error });
      continue;
    }
    if (!SKILL_ID_RE.test(skill.id)) {
      result.skipped.push({ id: skill.id, reason: "its name does not make a usable id here" });
      continue;
    }
    const target = join(skillsDir(scope), skill.id);
    if (existsSync(target) && !replace) {
      result.skipped.push({ id: skill.id, reason: "already here — import again with replace to update it" });
      continue;
    }
    // Replaced wholesale rather than merged: files upstream deleted must not
    // survive here, still being pointed at by prose that no longer mentions them.
    rmSync(target, { recursive: true, force: true });
    mkdirSync(skillsDir(scope), { recursive: true, mode: 0o700 });
    cpSync(join(root, wanted), target, { recursive: true, filter: (src) => !src.includes(`${"/"}.git${"/"}`) });
    // The copy is renamed to the id it is known by here, so the skill is
    // self-consistent wherever it is later handed to a harness.
    const file = join(target, "SKILL.md");
    const normalized = withSkillName(readFileSync(file, "utf8"), skill.id);
    if (normalized !== readFileSync(file, "utf8")) {
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(file, normalized, { mode: 0o600 });
    }
    const origin: SkillOrigin = {
      sourceId,
      sourceSkill: wanted,
      commit: source.headSha,
      importedAt: Date.now(),
      // Stamped with what is on disk after normalizing, so an untouched import
      // does not read as a local edit the moment it lands.
      sha: skillSha(readFileSync(file, "utf8")),
    };
    writeOrigin(target, origin);
    result.imported.push(skill.id);
  }
  return result;
}
