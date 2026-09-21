import { templatePaths } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";

import { conditionPaths } from "./condition";
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
    // A step that is switched off reads nothing, so it may not be what a run
    // is refused over: the box would ask for a value nothing will ever use.
    if (node.disabled) continue;
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

/**
 * Which run-input keys a workflow's edge guards read, but no agent does.
 *
 * A guard like `input.deliver == "branch"` decides where a run ends, not
 * whether it can start — the edge without a match is still there to take. So
 * this is kept apart from `requiredRunInputs`: promoting a guard-read key to
 * required would refuse every existing run that starts without it, over a
 * value the run only needs if it ever reaches that fork.
 */
export function optionalRunInputs(wf: WorkflowDefinition, loadAgent: (id: string) => AgentDefinition): string[] {
  const keys = new Set<string>();
  for (const node of wf.nodes) {
    // A step that is switched off never evaluates its guards: the run takes
    // `skipTo` instead, so asking for a value only that guard would have read
    // is noise, the same reason `requiredRunInputs` skips it.
    if ("disabled" in node && node.disabled) continue;
    for (const edge of node.edges) {
      if (!edge.condition) continue;
      for (const path of conditionPaths(edge.condition)) {
        if (path[0] !== "input" || !path[1]) continue;
        keys.add(path[1]);
      }
    }
  }
  const required = new Set(requiredRunInputs(wf, loadAgent));
  return [...keys].filter((key) => !required.has(key)).sort();
}

/** The keys a run was started without. */
export function missingRunInputs(required: string[], input: Record<string, unknown>): string[] {
  return required.filter((key) => input[key] === undefined || input[key] === "");
}
