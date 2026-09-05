import type { WorkflowDefinition } from "./types";

/**
 * Which workflows name each agent.
 *
 * Deleting an agent a workflow still references does not fail: the file just
 * goes, and the workflow stops parsing the next time it is loaded. Knowing that
 * up front is the difference between a warned decision and a broken pipeline
 * discovered at run time.
 */
export function agentUsage(workflows: Array<Pick<WorkflowDefinition, "id" | "nodes">>): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const wf of workflows) {
    for (const node of wf.nodes) {
      if (node.type !== "agent") continue;
      const users = usage.get(node.agent) ?? [];
      if (!users.includes(wf.id)) users.push(wf.id);
      usage.set(node.agent, users);
    }
  }
  return usage;
}
