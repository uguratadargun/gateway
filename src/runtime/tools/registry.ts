import { MEMORY_TOOLS } from "./memory-tools";
import type { AgentTool } from "./types";
import { WORKSPACE_TOOLS } from "./workspace-tools";

/**
 * The tool vocabulary an agent file may draw from. Names are validated when an
 * agent is saved, so a typo fails in the editor rather than mid-run.
 */

const BY_NAME = new Map<string, AgentTool>([...WORKSPACE_TOOLS, ...MEMORY_TOOLS].map((t) => [t.name, t]));

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
 * The tools an agent actually gets for a run. A file tool needs a workspace,
 * so a workflow without one runs its agents in prose-only mode — the same
 * agent file works both ways. The memory tools need none and are kept.
 */
export function toolsFor(names: string[], hasWorkspace: boolean): AgentTool[] {
  const out: AgentTool[] = [];
  for (const name of names) {
    const tool = BY_NAME.get(name);
    if (!tool) continue;
    if (!hasWorkspace && !tool.workspaceFree) continue;
    out.push(tool);
  }
  return out;
}
