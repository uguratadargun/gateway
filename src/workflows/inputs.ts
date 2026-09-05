import { templatePaths } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";

import type { WorkflowDefinition } from "./types";

/**
 * Which run-input keys a workflow needs.
 *
 * Agents read `input.*` straight from what the run was started with, and an
 * unresolved placeholder fails the node. Collecting the keys up front lets the
 * UI pre-fill the run box and lets a run be refused with a clear message
 * instead of dying on its first agent.
 */
export function requiredRunInputs(wf: WorkflowDefinition, loadAgent: (id: string) => AgentDefinition): string[] {
  const keys = new Set<string>();
  const add = (path: string) => {
    if (!path.startsWith("input.")) return;
    const key = path.slice("input.".length).split(".")[0];
    if (key) keys.add(key);
  };

  for (const node of wf.nodes) {
    if (node.type !== "agent") continue;
    let agent: AgentDefinition;
    try {
      agent = loadAgent(node.agent);
    } catch {
      // A missing agent is reported elsewhere; it cannot contribute keys.
      continue;
    }
    for (const path of templatePaths(agent.prompt)) add(path);
    for (const declared of node.inputs ?? agent.inputs) add(declared.replace(/\?$/, ""));
  }
  // A workspace without a pinned repository takes it per run, so the same
  // pipeline can be pointed at whatever project the caller is working in.
  if (wf.workspace && !wf.workspace.repo) keys.add("repo");
  return [...keys].sort();
}

/** The keys a run was started without. */
export function missingRunInputs(required: string[], input: Record<string, unknown>): string[] {
  return required.filter((key) => input[key] === undefined || input[key] === "");
}
