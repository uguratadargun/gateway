import { WORKSPACE_TOOLS } from "./workspace-tools";
import type { AgentTool } from "./types";

/**
 * The tool vocabulary an agent file may draw from. Names are validated when an
 * agent is saved, so a typo fails in the editor rather than mid-run.
 */

const BY_NAME = new Map<string, AgentTool>(WORKSPACE_TOOLS.map((t) => [t.name, t]));

export function knownToolNames(): string[] {
  return [...BY_NAME.keys()].sort();
}

export function isKnownTool(name: string): boolean {
  return BY_NAME.has(name);
}

export function getTool(name: string): AgentTool | undefined {
  return BY_NAME.get(name);
}

/**
 * The tools an agent actually gets for a run. Every tool needs a workspace, so
 * a workflow without one runs its agents in prose-only mode — the same agent
 * file works both ways.
 */
export function toolsFor(names: string[], hasWorkspace: boolean): AgentTool[] {
  if (!hasWorkspace) return [];
  const out: AgentTool[] = [];
  for (const name of names) {
    const tool = BY_NAME.get(name);
    if (tool) out.push(tool);
  }
  return out;
}
