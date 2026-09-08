import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentExists } from "@/agents/registry";
import { ownScope, teamScope, type DefinitionScope } from "@/lib/def-root";
import { WorkflowError } from "@/runtime/errors";

import { parseWorkflow } from "./loader";
import type { WorkflowDefinition } from "./types";

/**
 * File-backed workflow store: <scope>/workflows/<id>.yaml, mirroring the agent
 * registry so definitions stay hand-editable and diffable.
 *
 * A workflow is validated against the agents in its own scope: a team's
 * pipeline may only name that team's agents, and the cache a client pulled is
 * checked against the agents it pulled with it.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function workflowsDir(scope: DefinitionScope = teamScope()): string {
  return join(scope.root, "workflows");
}

function invalid(id: string, message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message, { workflowId: id });
}

/**
 * Both extensions are listed, so both have to resolve: an existing file wins,
 * and anything new is written as .yaml.
 */
function pathFor(id: string, scope: DefinitionScope): string {
  // Guards against traversal: ids are a flat, restricted vocabulary.
  if (!ID_RE.test(id)) throw invalid(id, "invalid workflow id (use lowercase letters, digits and dashes)");
  const yaml = join(workflowsDir(scope), `${id}.yaml`);
  if (existsSync(yaml)) return yaml;
  const yml = join(workflowsDir(scope), `${id}.yml`);
  return existsSync(yml) ? yml : yaml;
}

/**
 * Keyed by file *and* the scope reading it: an inherited workflow is parsed
 * against the borrowing team's agents, so two teams can hold different valid
 * readings of the same file.
 */
const cache = new Map<string, { mtimeMs: number; def: WorkflowDefinition }>();

/**
 * Drops every scope's reading of one file. A shared workflow is cached once per
 * team that borrows it, so a save has to invalidate all of them or a team keeps
 * running the version it happened to load first.
 */
function forget(file: string): void {
  for (const key of cache.keys()) {
    if (key.endsWith(`\u0000${file}`)) cache.delete(key);
  }
}

function loadFile(id: string, file: string, scope: DefinitionScope): WorkflowDefinition {
  const stat = statSync(file);
  const key = `${scope.teamId ?? scope.root}\u0000${file}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseWorkflow(id, readFileSync(file, "utf8"), {
    sourcePath: file,
    updatedAt: stat.mtimeMs,
    agentExists: (agentId: string) => agentExists(agentId, scope),
  });
  cache.set(key, { mtimeMs: stat.mtimeMs, def });
  return def;
}

/** All valid workflows, plus the files that failed to parse (surfaced in the UI). */
export function listWorkflows(scope: DefinitionScope = teamScope()): {
  workflows: WorkflowDefinition[];
  errors: Array<{ id: string; message: string }>;
} {
  const dir = workflowsDir(scope);
  if (!existsSync(dir)) return { workflows: [], errors: [] };
  const workflows: WorkflowDefinition[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const id = entry.replace(/\.ya?ml$/, "");
    try {
      workflows.push(loadFile(id, join(dir, entry), scope));
    } catch (e) {
      errors.push({ id, message: (e as Error).message });
    }
  }
  return { workflows, errors };
}

/**
 * The file backing an id, and the scope it should be validated in.
 *
 * A workflow inherited from the default team is validated against the team
 * that is *using* it: its agents resolve through the same chain, so a shared
 * pipeline works for a team that has replaced one of the agents it names.
 */
function resolveFile(id: string, scope: DefinitionScope): string | null {
  const own = pathFor(id, scope);
  if (existsSync(own)) return own;
  if (scope.fallback) return resolveFile(id, scope.fallback);
  return null;
}

export function getWorkflow(id: string, scope: DefinitionScope = teamScope()): WorkflowDefinition {
  const file = resolveFile(id, scope);
  if (!file) throw invalid(id, "workflow not found");
  return loadFile(id, file, scope);
}

export function workflowExists(id: string, scope: DefinitionScope = teamScope()): boolean {
  return resolveFile(id, scope) !== null;
}

/** Raw YAML source, for the editor. */
export function readWorkflowSource(id: string, scope: DefinitionScope = teamScope()): string {
  const file = resolveFile(id, scope);
  if (!file) throw invalid(id, "workflow not found");
  return readFileSync(file, "utf8");
}

/** What this scope can run but does not own. See `inheritedAgents`. */
export function inheritedWorkflows(scope: DefinitionScope = teamScope()): WorkflowDefinition[] {
  if (!scope.fallback) return [];
  const own = new Set(listWorkflows(ownScope(scope)).workflows.map((w) => w.id));
  // Loaded in the borrowing scope, so their agents resolve the way they will
  // when the team actually runs them.
  const inherited: WorkflowDefinition[] = [];
  for (const wf of listWorkflows(scope.fallback).workflows) {
    if (own.has(wf.id)) continue;
    try {
      inherited.push(getWorkflow(wf.id, scope));
    } catch {
      // Broken for this team (an agent it names is missing here): it is not
      // offered rather than offered and refused at run time.
    }
  }
  return inherited;
}

/** Validate then write. An invalid definition never reaches disk. */
export function saveWorkflow(id: string, raw: string, scope: DefinitionScope = teamScope()): WorkflowDefinition {
  const file = pathFor(id, scope);
  parseWorkflow(id, raw, {
    sourcePath: file,
    updatedAt: Date.now(),
    agentExists: (agentId: string) => agentExists(agentId, scope),
  });
  const dir = workflowsDir(scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  forget(file);
  return getWorkflow(id, scope);
}

/** Removes the scope's own copy. An inherited workflow is not this team's to delete. */
export function deleteWorkflow(id: string, scope: DefinitionScope = teamScope()): boolean {
  const file = pathFor(id, scope);
  if (!existsSync(file)) return false;
  rmSync(file);
  forget(file);
  return true;
}

/** The same registry, bound to one scope. See `agentRegistryFor`. */
export function workflowRegistryFor(scope: DefinitionScope) {
  return {
    scope,
    dir: () => workflowsDir(scope),
    list: () => listWorkflows(scope),
    get: (id: string) => getWorkflow(id, scope),
    exists: (id: string) => workflowExists(id, scope),
    readSource: (id: string) => readWorkflowSource(id, scope),
    save: (id: string, raw: string) => saveWorkflow(id, raw, scope),
    remove: (id: string) => deleteWorkflow(id, scope),
  };
}

export type WorkflowRegistry = ReturnType<typeof workflowRegistryFor>;
