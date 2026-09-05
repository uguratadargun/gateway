import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentDefinitionError, parseAgent } from "./loader";
import type { AgentDefinition } from "./types";

/**
 * File-backed agent store: ~/.gate/agents/<id>.md, one Markdown file per
 * agent, so definitions stay hand-editable and diffable — the same convention
 * settings.json and routing.json already follow.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function agentsDir(): string {
  return join(process.env.GATE_HOME || join(homedir(), ".gate"), "agents");
}

function pathFor(id: string): string {
  // Guards against traversal: ids are a flat, restricted vocabulary.
  if (!ID_RE.test(id)) throw new AgentDefinitionError("invalid agent id (use lowercase letters, digits and dashes)", id);
  return join(agentsDir(), `${id}.md`);
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
export function listAgents(): { agents: AgentDefinition[]; errors: Array<{ id: string; message: string }> } {
  const dir = agentsDir();
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

export function getAgent(id: string): AgentDefinition {
  const file = pathFor(id);
  if (!existsSync(file)) throw new AgentDefinitionError("agent not found", id);
  return loadFile(id, file);
}

export function agentExists(id: string): boolean {
  const file = pathFor(id);
  return existsSync(file);
}

/** Raw Markdown source, for the editor. */
export function readAgentSource(id: string): string {
  const file = pathFor(id);
  if (!existsSync(file)) throw new AgentDefinitionError("agent not found", id);
  return readFileSync(file, "utf8");
}

/** Validate then write. An invalid definition never reaches disk. */
export function saveAgent(id: string, raw: string): AgentDefinition {
  const file = pathFor(id);
  parseAgent(id, raw, { sourcePath: file, updatedAt: Date.now() });
  const dir = agentsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  cache.delete(file);
  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  const file = pathFor(id);
  if (!existsSync(file)) return false;
  rmSync(file);
  cache.delete(file);
  return true;
}
