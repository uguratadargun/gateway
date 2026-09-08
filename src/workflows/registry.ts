import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentExists } from "@/agents/registry";
import { teamScope, type DefinitionScope } from "@/lib/def-root";
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

const cache = new Map<string, { mtimeMs: number; def: WorkflowDefinition }>();

function loadFile(id: string, file: string, scope: DefinitionScope): WorkflowDefinition {
  const stat = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseWorkflow(id, readFileSync(file, "utf8"), {
    sourcePath: file,
    updatedAt: stat.mtimeMs,
    agentExists: (agentId: string) => agentExists(agentId, scope),
  });
  cache.set(file, { mtimeMs: stat.mtimeMs, def });
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

export function getWorkflow(id: string, scope: DefinitionScope = teamScope()): WorkflowDefinition {
  const file = pathFor(id, scope);
  if (!existsSync(file)) throw invalid(id, "workflow not found");
  return loadFile(id, file, scope);
}

export function workflowExists(id: string, scope: DefinitionScope = teamScope()): boolean {
  return existsSync(pathFor(id, scope));
}

/** Raw YAML source, for the editor. */
export function readWorkflowSource(id: string, scope: DefinitionScope = teamScope()): string {
  const file = pathFor(id, scope);
  if (!existsSync(file)) throw invalid(id, "workflow not found");
  return readFileSync(file, "utf8");
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
  cache.delete(file);
  return getWorkflow(id, scope);
}

export function deleteWorkflow(id: string, scope: DefinitionScope = teamScope()): boolean {
  const file = pathFor(id, scope);
  if (!existsSync(file)) return false;
  rmSync(file);
  cache.delete(file);
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
