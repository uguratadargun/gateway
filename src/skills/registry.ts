import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ownScope, teamScope, type DefinitionScope } from "@/lib/def-root";

import { parseSkill, SkillDefinitionError } from "./loader";
import { SKILL_ID_RE, type SkillDefinition, type SkillOrigin } from "./types";

/**
 * File-backed skill store: `<scope>/skills/<id>/SKILL.md`, one directory per
 * skill, beside the `agents/` and `workflows/` the same scope already holds.
 *
 * Team scoping works exactly as it does for agents: a team's own copy of a
 * name wins, anything it has not written it inherits from the default team's
 * library, and nothing here can write into the fallback. That is what makes a
 * shared skill library shareable — a team can replace `brainstorming` with its
 * own without asking anyone, and without affecting anyone.
 */

/** Provenance, written beside SKILL.md when a skill is imported from a source. */
export const ORIGIN_FILE = ".gate-source.json";

/** A skill's own files are prose and small scripts; a directory tree that deep is a mistake. */
const MAX_RESOURCE_DEPTH = 4;

export function skillsDir(scope: DefinitionScope = teamScope()): string {
  return join(scope.root, "skills");
}

function dirFor(id: string, scope: DefinitionScope): string {
  // Guards against traversal: ids are a flat, restricted vocabulary.
  if (!SKILL_ID_RE.test(id)) throw new SkillDefinitionError("invalid skill id (use lowercase letters, digits and dashes)", id);
  return join(skillsDir(scope), id);
}

const cache = new Map<string, { mtimeMs: number; def: SkillDefinition }>();

/** Everything beside SKILL.md, so the editor can show what a skill carries. */
function resourcesIn(dir: string, depth = 0): string[] {
  if (depth > MAX_RESOURCE_DEPTH) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ORIGIN_FILE) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...resourcesIn(full, depth + 1));
    else if (!(depth === 0 && entry.name === "SKILL.md")) out.push(full);
  }
  return out;
}

function readOrigin(dir: string): SkillOrigin | null {
  try {
    return JSON.parse(readFileSync(join(dir, ORIGIN_FILE), "utf8")) as SkillOrigin;
  } catch {
    return null;
  }
}

export function writeOrigin(dir: string, origin: SkillOrigin): void {
  writeFileSync(join(dir, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The parse is cached against SKILL.md's mtime; the file listing is not.
 *
 * A skill's other files change without SKILL.md changing — one is added by
 * hand, or a re-import brings a new one — and a cached list would then say the
 * skill ships something it does not, or miss something it does. Reading a
 * handful of directory entries is cheap; parsing YAML and holding the prose is
 * the part worth keeping.
 */
function loadDir(id: string, dir: string): SkillDefinition {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) throw new SkillDefinitionError("no SKILL.md in this directory", id);
  const stat = statSync(file);
  const resources = resourcesIn(dir).map((f) => relative(dir, f));
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return { ...hit.def, resources, origin: readOrigin(dir) };
  const def = parseSkill(id, readFileSync(file, "utf8"), {
    dir,
    sourcePath: file,
    updatedAt: stat.mtimeMs,
    resources,
    origin: readOrigin(dir),
  });
  cache.set(file, { mtimeMs: stat.mtimeMs, def });
  return def;
}

/** All valid skills, plus the directories that failed to parse (surfaced in the UI). */
export function listSkills(scope: DefinitionScope = teamScope()): {
  skills: SkillDefinition[];
  errors: Array<{ id: string; message: string }>;
} {
  const dir = skillsDir(scope);
  if (!existsSync(dir)) return { skills: [], errors: [] };
  const skills: SkillDefinition[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    try {
      skills.push(loadDir(entry.name, join(dir, entry.name)));
    } catch (e) {
      errors.push({ id: entry.name, message: (e as Error).message });
    }
  }
  return { skills, errors };
}

/** The directory backing an id: this scope's own, or the one it inherits. */
export function resolveSkillDir(id: string, scope: DefinitionScope): string | null {
  const own = dirFor(id, scope);
  if (existsSync(join(own, "SKILL.md"))) return own;
  if (scope.fallback) return resolveSkillDir(id, scope.fallback);
  return null;
}

export function getSkill(id: string, scope: DefinitionScope = teamScope()): SkillDefinition {
  const dir = resolveSkillDir(id, scope);
  if (!dir) throw new SkillDefinitionError("skill not found", id);
  return loadDir(id, dir);
}

export function skillExists(id: string, scope: DefinitionScope = teamScope()): boolean {
  return resolveSkillDir(id, scope) !== null;
}

/** Raw SKILL.md, for the editor. */
export function readSkillSource(id: string, scope: DefinitionScope = teamScope()): string {
  const dir = resolveSkillDir(id, scope);
  if (!dir) throw new SkillDefinitionError("skill not found", id);
  return readFileSync(join(dir, "SKILL.md"), "utf8");
}

/** What this scope can use but does not own, and so may not edit here. */
export function inheritedSkills(scope: DefinitionScope = teamScope()): SkillDefinition[] {
  if (!scope.fallback) return [];
  const own = new Set(listSkills(ownScope(scope)).skills.map((s) => s.id));
  return listSkills(scope.fallback).skills.filter((s) => !own.has(s.id));
}

/**
 * Validate then write SKILL.md. An invalid skill never reaches disk.
 *
 * Only SKILL.md is written: a skill's other files arrive with an import or are
 * put there by hand, and a form that could silently drop them would make the
 * first save after an import lossy.
 */
export function saveSkill(id: string, raw: string, scope: DefinitionScope = teamScope()): SkillDefinition {
  const dir = dirFor(id, scope);
  parseSkill(id, raw, { dir, sourcePath: join(dir, "SKILL.md"), updatedAt: Date.now() });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  cache.delete(file);
  return getSkill(id, scope);
}

/** Removes the scope's own copy, files and all. An inherited skill is not this team's to delete. */
export function deleteSkill(id: string, scope: DefinitionScope = teamScope()): boolean {
  const dir = dirFor(id, scope);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  cache.delete(join(dir, "SKILL.md"));
  return true;
}

/** The same registry, bound to one scope — mirrors `agentRegistryFor`. */
export function skillRegistryFor(scope: DefinitionScope) {
  return {
    scope,
    dir: () => skillsDir(scope),
    list: () => listSkills(scope),
    get: (id: string) => getSkill(id, scope),
    exists: (id: string) => skillExists(id, scope),
    readSource: (id: string) => readSkillSource(id, scope),
    save: (id: string, raw: string) => saveSkill(id, raw, scope),
    remove: (id: string) => deleteSkill(id, scope),
  };
}

export type SkillRegistry = ReturnType<typeof skillRegistryFor>;
