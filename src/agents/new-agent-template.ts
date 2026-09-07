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
timeoutMs: 3600000
---
You are the ${id} agent.

Describe the task here. To read an upstream node's output, declare it above
(inputs: [planner.plan]) and reference it in double braces — see the seeded
agents in ~/.gate/agents for working examples.

timeoutMs is one hour, the default, spelled out so you know it is there: it
covers the whole node including every tool round. Raise it for an agent that
works through a large repository, or set 0 for no timeout at all.
`;
}
