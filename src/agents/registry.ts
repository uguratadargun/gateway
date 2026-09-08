import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { teamScope, type DefinitionScope } from "@/lib/def-root";

import { AgentDefinitionError, parseAgent } from "./loader";
import type { AgentDefinition } from "./types";

/**
 * File-backed agent store: <scope>/agents/<id>.md, one Markdown file per
 * agent, so definitions stay hand-editable and diffable — the same convention
 * settings.json and routing.json already follow.
 *
 * The scope is a team's directory on the server, or the read-only cache the
 * client CLI pulled into on a developer's machine. It defaults to the default
 * team, which is what every caller written before teams existed means.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function agentsDir(scope: DefinitionScope = teamScope()): string {
  return join(scope.root, "agents");
}

function pathFor(id: string, scope: DefinitionScope): string {
  // Guards against traversal: ids are a flat, restricted vocabulary.
  if (!ID_RE.test(id)) throw new AgentDefinitionError("invalid agent id (use lowercase letters, digits and dashes)", id);
  return join(agentsDir(scope), `${id}.md`);
}

const cache = new Map<string, { mtimeMs: number; def: AgentDefinition }>();

function loadFile(id: string, file: string): AgentDefinition {
  const stat = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseAgent(id, readFileSync(file, "utf8"), { sourcePath: file, updatedAt: stat.mtimeMs });
  cache.set(file, { mtimeMs: stat.mtimeMs, def });
  return def;
}

/** All valid agents, plus the files that failed to parse (surfaced in the UI). */
export function listAgents(scope: DefinitionScope = teamScope()): {
  agents: AgentDefinition[];
  errors: Array<{ id: string; message: string }>;
} {
  const dir = agentsDir(scope);
  if (!existsSync(dir)) return { agents: [], errors: [] };
  const agents: AgentDefinition[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    try {
      agents.push(loadFile(id, join(dir, entry)));
    } catch (e) {
      errors.push({ id, message: (e as Error).message });
    }
  }
  return { agents, errors };
}

export function getAgent(id: string, scope: DefinitionScope = teamScope()): AgentDefinition {
  const file = pathFor(id, scope);
  if (!existsSync(file)) throw new AgentDefinitionError("agent not found", id);
  return loadFile(id, file);
}

export function agentExists(id: string, scope: DefinitionScope = teamScope()): boolean {
  return existsSync(pathFor(id, scope));
}

/** Raw Markdown source, for the editor. */
export function readAgentSource(id: string, scope: DefinitionScope = teamScope()): string {
  const file = pathFor(id, scope);
  if (!existsSync(file)) throw new AgentDefinitionError("agent not found", id);
  return readFileSync(file, "utf8");
}

/** Validate then write. An invalid definition never reaches disk. */
export function saveAgent(id: string, raw: string, scope: DefinitionScope = teamScope()): AgentDefinition {
  const file = pathFor(id, scope);
  parseAgent(id, raw, { sourcePath: file, updatedAt: Date.now() });
  const dir = agentsDir(scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  cache.delete(file);
  return getAgent(id, scope);
}

export function deleteAgent(id: string, scope: DefinitionScope = teamScope()): boolean {
  const file = pathFor(id, scope);
  if (!existsSync(file)) return false;
  rmSync(file);
  cache.delete(file);
  return true;
}

/**
 * The same registry, bound to one scope.
 *
 * Everything downstream — the workflow loader's `agentExists`, the engine's
 * `loadAgent`, `requiredRunInputs` — already takes these as functions, so
 * binding the scope once here is the whole of making them team-aware.
 */
export function agentRegistryFor(scope: DefinitionScope) {
  return {
    scope,
    dir: () => agentsDir(scope),
    list: () => listAgents(scope),
    get: (id: string) => getAgent(id, scope),
    exists: (id: string) => agentExists(id, scope),
    readSource: (id: string) => readAgentSource(id, scope),
    save: (id: string, raw: string) => saveAgent(id, raw, scope),
    remove: (id: string) => deleteAgent(id, scope),
  };
}

export type AgentRegistry = ReturnType<typeof agentRegistryFor>;
