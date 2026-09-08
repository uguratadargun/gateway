import { describe, expect, it } from "vitest";

import { POST as saveDefinition } from "@/app/api/v1/definitions/route";
import { agentExists, readAgentSource } from "@/agents/registry";
import { createKey } from "@/lib/apikeys";
import { teamScope } from "@/lib/def-root";
import { createTeam } from "@/lib/teams";
import { workflowExists } from "@/workflows/registry";

/**
 * Writing a definition from the machine it was designed on.
 *
 * The client is read-only everywhere else, so the boundary being tested is the
 * scope: an ordinary key reads its team's definitions and an `author` key
 * writes them — into its own team, through the same validation the dashboard
 * uses, and never over something that is already there by accident.
 */

const AGENT = `---
name: Designed
---
Do the designed work.
`;

const WORKFLOW = `name: Designed
entry: only
nodes:
  - id: only
    type: agent
    agent: designed
    next: done
  - id: done
    type: terminal
`;

function push(key: string, body: Record<string, unknown>): Promise<Response> {
  return saveDefinition(
    new Request("http://gate.test/api/v1/definitions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("authoring from a client", () => {
  const team = "authors";
  let author = "";
  let reader = "";

  it("refuses a key that may only read", async () => {
    createTeam("Authors", team);
    author = createKey({ name: "author", teamId: team, scopes: ["gateway", "workflows", "author"] }).plaintext;
    reader = createKey({ name: "reader", teamId: team }).plaintext;

    const res = await push(reader, { kind: "agent", id: "designed", source: AGENT });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("SCOPE_MISSING");
    expect(agentExists("designed", teamScope(team))).toBe(false);
  });

  it("saves into the key's own team, validating as the dashboard does", async () => {
    // The workflow first, to prove the ordering matters and is enforced by
    // validation rather than by hope.
    const early = await push(author, { kind: "workflow", id: "designed-flow", source: WORKFLOW });
    expect(early.status).toBe(400);
    expect((await early.json()).error).toMatch(/unknown agent "designed"/);

    expect((await push(author, { kind: "agent", id: "designed", source: AGENT })).status).toBe(200);
    expect((await push(author, { kind: "workflow", id: "designed-flow", source: WORKFLOW })).status).toBe(200);

    expect(readAgentSource("designed", teamScope(team))).toContain("Do the designed work.");
    expect(workflowExists("designed-flow", teamScope(team))).toBe(true);
    // And nowhere else.
    expect(agentExists("designed", teamScope("default"))).toBe(false);
  });

  it("does not overwrite an existing definition unless asked", async () => {
    const res = await push(author, { kind: "agent", id: "designed", source: AGENT });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EXISTS");

    const replaced = await push(author, {
      kind: "agent",
      id: "designed",
      source: AGENT.replace("Do the designed work.", "Do it differently."),
      replace: true,
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ replaced: true });
    expect(readAgentSource("designed", teamScope(team))).toContain("Do it differently.");
  });
});
