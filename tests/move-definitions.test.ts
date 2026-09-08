import { describe, expect, it } from "vitest";

import { POST as moveAgent } from "@/app/api/agents/[id]/move/route";
import { POST as moveWorkflow } from "@/app/api/workflows/[id]/move/route";
import { agentExists, saveAgent } from "@/agents/registry";
import { teamScope } from "@/lib/def-root";
import { createTeam } from "@/lib/teams";
import { saveWorkflow, workflowExists } from "@/workflows/registry";

/**
 * Assigning a definition to another team.
 *
 * A definition belongs to exactly one team, so this is a move — and the thing
 * worth testing is what happens when it cannot be one: a workflow whose agents
 * are still behind must stay where it works rather than land somewhere broken.
 */

const AGENT = `---
name: Mover
---
Do the work.
`;

const WORKFLOW = `name: Mover
entry: only
nodes:
  - id: only
    type: agent
    agent: mover
    next: done
  - id: done
    type: terminal
`;

function request(from: string, to: string): Request {
  return new Request(`http://gate.test/api/x/move?team=${from}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("moving definitions between teams", () => {
  it("refuses a workflow whose agents are still behind, and leaves it where it was", async () => {
    createTeam("Source", "source");
    createTeam("Target", "target");
    saveAgent("mover", AGENT, teamScope("source"));
    saveWorkflow("mover-flow", WORKFLOW, teamScope("source"));

    const res = await moveWorkflow(request("source", "target"), params("mover-flow"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/unknown agent "mover"/);
    // The point of validating in the destination first: nothing moved.
    expect(workflowExists("mover-flow", teamScope("source"))).toBe(true);
    expect(workflowExists("mover-flow", teamScope("target"))).toBe(false);
  });

  it("moves the agent, naming what it leaves behind, and then the workflow follows", async () => {
    const agentRes = await moveAgent(request("source", "target"), params("mover"));
    expect(agentRes.status).toBe(200);
    // The workflow still names it and will stop loading: said, not prevented.
    expect(await agentRes.json()).toMatchObject({ moved: true, orphaned: ["mover-flow"] });
    expect(agentExists("mover", teamScope("target"))).toBe(true);
    expect(agentExists("mover", teamScope("source"))).toBe(false);

    const wfRes = await moveWorkflow(request("source", "target"), params("mover-flow"));
    expect(wfRes.status).toBe(200);
    expect(workflowExists("mover-flow", teamScope("target"))).toBe(true);
    expect(workflowExists("mover-flow", teamScope("source"))).toBe(false);
  });

  it("refuses to overwrite a name the destination already uses", async () => {
    createTeam("Other", "other");
    saveAgent("mover", AGENT, teamScope("other"));
    const res = await moveAgent(request("target", "other"), params("mover"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already has an agent/);
    // Both copies survive: one of them is somebody's work.
    expect(agentExists("mover", teamScope("target"))).toBe(true);
    expect(agentExists("mover", teamScope("other"))).toBe(true);
  });
});
