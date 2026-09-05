import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { agentExists } from "@/agents/registry";
import { WorkflowError } from "@/runtime/errors";

import { parseWorkflow } from "./loader";
import type { WorkflowDefinition } from "./types";

/**
 * File-backed workflow store: ~/.gate/workflows/<id>.yaml, mirroring the agent
 * registry so definitions stay hand-editable and diffable.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function workflowsDir(): string {
  return join(process.env.GATE_HOME || join(homedir(), ".gate"), "workflows");
}

function invalid(id: string, message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message, { workflowId: id });
}

/**
 * Both extensions are listed, so both have to resolve: an existing file wins,
 * and anything new is written as .yaml.
 */
function pathFor(id: string): string {
  // Guards against traversal: ids are a flat, restricted vocabulary.
  if (!ID_RE.test(id)) throw invalid(id, "invalid workflow id (use lowercase letters, digits and dashes)");
  const yaml = join(workflowsDir(), `${id}.yaml`);
  if (existsSync(yaml)) return yaml;
  const yml = join(workflowsDir(), `${id}.yml`);
  return existsSync(yml) ? yml : yaml;
}

const cache = new Map<string, { mtimeMs: number; def: WorkflowDefinition }>();

function loadFile(id: string, file: string): WorkflowDefinition {
  const stat = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseWorkflow(id, readFileSync(file, "utf8"), {
    sourcePath: file,
    updatedAt: stat.mtimeMs,
    agentExists,
  });
  cache.set(file, { mtimeMs: stat.mtimeMs, def });
  return def;
}

/** All valid workflows, plus the files that failed to parse (surfaced in the UI). */
export function listWorkflows(): { workflows: WorkflowDefinition[]; errors: Array<{ id: string; message: string }> } {
  const dir = workflowsDir();
  if (!existsSync(dir)) return { workflows: [], errors: [] };
  const workflows: WorkflowDefinition[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const id = entry.replace(/\.ya?ml$/, "");
    try {
      workflows.push(loadFile(id, join(dir, entry)));
    } catch (e) {
      errors.push({ id, message: (e as Error).message });
    }
  }
  return { workflows, errors };
}

export function getWorkflow(id: string): WorkflowDefinition {
  const file = pathFor(id);
  if (!existsSync(file)) throw invalid(id, "workflow not found");
  return loadFile(id, file);
}

export function workflowExists(id: string): boolean {
  return existsSync(pathFor(id));
}

/** Raw YAML source, for the editor. */
export function readWorkflowSource(id: string): string {
  const file = pathFor(id);
  if (!existsSync(file)) throw invalid(id, "workflow not found");
  return readFileSync(file, "utf8");
}

/** Validate then write. An invalid definition never reaches disk. */
export function saveWorkflow(id: string, raw: string): WorkflowDefinition {
  const file = pathFor(id);
  parseWorkflow(id, raw, { sourcePath: file, updatedAt: Date.now(), agentExists });
  const dir = workflowsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  cache.delete(file);
  return getWorkflow(id);
}

export function deleteWorkflow(id: string): boolean {
  const file = pathFor(id);
  if (!existsSync(file)) return false;
  rmSync(file);
  cache.delete(file);
  return true;
}
