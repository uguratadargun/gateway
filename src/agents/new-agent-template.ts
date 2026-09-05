/**
 * The starting point the dashboard offers for a new agent. It lives here, and
 * is covered by a test, because it has to satisfy the same validator every
 * saved agent does — an example placeholder in the body once made "New agent"
 * fail with "references undeclared input".
 */
export function newAgentTemplate(id: string): string {
  return `---
name: ${id}
description: What this agent is for.
model: sonnet
effort: medium
inputs: []
output:
  type: text
---
You are the ${id} agent.

Describe the task here. To read an upstream node's output, declare it above
(inputs: [planner.plan]) and reference it in double braces — see the seeded
agents in ~/.gate/agents for working examples.
`;
}
