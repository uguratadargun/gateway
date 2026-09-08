import { describe, expect, it } from "vitest";

import { getAgent, listAgents, saveAgent } from "@/agents/registry";
import { createExecution, getExecution } from "@/executions/store";
import { createKey, resolveKey, revokeKey, type Principal } from "@/lib/apikeys";
import { getDb } from "@/lib/db";
import { teamScope } from "@/lib/def-root";
import { isOlderThan, MIN_CLIENT_VERSION, VERSION_HEADERS } from "@/lib/protocol";
import { ownsExecution, requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { createTeam, createUser, updateUser } from "@/lib/teams";
import { listWorkflows, saveWorkflow } from "@/workflows/registry";

/**
 * Multi-user gate: a key is a person, a person is in a team, and a team's
 * definitions are its own. These are the boundaries a second team on the same
 * server is trusting, so each one is checked from the outside — through the
 * functions the API routes actually call.
 */

const AGENT = `---
name: Solo
---
Do the thing.
`;

const WORKFLOW = `name: Solo
entry: only
nodes:
  - id: only
    type: agent
    agent: solo
    next: done
  - id: done
    type: terminal
`;

function keyFor(teamId: string, scopes?: ("gateway" | "workflows")[]): string {
  return createKey({ name: `${teamId} key`, teamId, scopes }).plaintext;
}

function request(key: string | null): Request {
  return new Request("http://gate.test/api/v1/me", {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

describe("team-scoped definitions", () => {
  it("keeps one team's agents and workflows out of another's", () => {
    createTeam("Alpha", "alpha");
    createTeam("Beta", "beta");
    const alpha = teamScope("alpha");
    const beta = teamScope("beta");

    saveAgent("solo", AGENT, alpha);
    saveWorkflow("solo-flow", WORKFLOW, alpha);

    expect(listWorkflows(alpha).workflows.map((w) => w.id)).toContain("solo-flow");
    expect(listWorkflows(beta).workflows).toHaveLength(0);
    expect(listAgents(beta).agents).toHaveLength(0);
    expect(() => getAgent("solo", beta)).toThrow();
  });

  it("refuses a workflow naming an agent that only another team has", () => {
    createTeam("Gamma", "gamma");
    // "solo" exists in alpha (above) but not here, so the same source that
    // saved cleanly there must be rejected here.
    expect(() => saveWorkflow("solo-flow", WORKFLOW, teamScope("gamma"))).toThrow(/solo/);
  });
});

describe("keys as identities", () => {
  it("resolves to the person and team it was issued to", () => {
    createTeam("Delta", "delta");
    const user = createUser({ email: "dev@delta.test", name: "Dev", teamId: "delta" });
    const { plaintext } = createKey({ name: "laptop", userId: user.id, teamId: "delta" });

    const principal = resolveKey(plaintext);
    expect(principal).toMatchObject({ userId: user.id, teamId: "delta" });
    expect(principal!.scopes).toEqual(["gateway", "workflows"]);
  });

  it("stops working when revoked, and when its owner is disabled", () => {
    createTeam("Epsilon", "epsilon");
    const user = createUser({ email: "gone@epsilon.test", teamId: "epsilon" });
    const revocable = createKey({ name: "a", userId: user.id, teamId: "epsilon" });
    const disabled = createKey({ name: "b", userId: user.id, teamId: "epsilon" });

    revokeKey(revocable.key.id);
    expect(resolveKey(revocable.plaintext)).toBeNull();

    expect(resolveKey(disabled.plaintext)).not.toBeNull();
    updateUser(user.id, { disabled: true });
    expect(resolveKey(disabled.plaintext)).toBeNull();
  });

  it("moves a person's keys with them when they change team", () => {
    createTeam("Zeta", "zeta");
    createTeam("Eta", "eta");
    const user = createUser({ email: "moved@zeta.test", teamId: "zeta" });
    const { plaintext } = createKey({ name: "laptop", userId: user.id, teamId: "zeta" });

    updateUser(user.id, { teamId: "eta" });
    expect(resolveKey(plaintext)!.teamId).toBe("eta");
  });
});

describe("client API auth", () => {
  it("refuses a missing key, an unknown key and a gateway-only key", async () => {
    createTeam("Theta", "theta");

    const none = requireClient(request(null));
    expect(none).toBeInstanceOf(Response);
    expect((none as Response).status).toBe(401);

    const unknown = requireClient(request("gate_not_a_real_key"));
    expect((unknown as Response).status).toBe(401);

    const gatewayOnly = keyFor("theta", ["gateway"]);
    const refused = requireClient(request(gatewayOnly));
    expect((refused as Response).status).toBe(403);
    expect(await (refused as Response).json()).toMatchObject({ code: "SCOPE_MISSING" });
  });

  it("serves a key for the default team even before anyone has opened /team", () => {
    // The row is created lazily; a gate that issued a key on day one and never
    // visited the team page must not refuse its own default.
    getDb().prepare("DELETE FROM teams WHERE id = 'default'").run();
    const principal = requireClient(request(createKey({ name: "day one" }).plaintext));
    expect(principal).not.toBeInstanceOf(Response);
    expect((principal as Principal).teamId).toBe("default");
  });

  it("hands a valid key its own team's scope", () => {
    createTeam("Iota", "iota");
    const principal = requireClient(request(keyFor("iota")));
    expect(principal).not.toBeInstanceOf(Response);
    expect(scopeForPrincipal(principal as never).root).toContain("teams/iota");
  });
});

describe("version skew", () => {
  it("orders versions, including malformed ones, without throwing", () => {
    expect(isOlderThan("0.13.0", "0.14.0")).toBe(true);
    expect(isOlderThan("0.13.0", "0.13.0")).toBe(false);
    expect(isOlderThan("1.0.0", "0.99.99")).toBe(false);
    expect(isOlderThan("0.9", "0.10.0")).toBe(true);
    // Unreadable is a reason to warn, never to fail: it sorts as 0.0.0.
    expect(isOlderThan("nonsense", "0.1.0")).toBe(true);
  });

  it("turns away a client too old to be served, with the fix", async () => {
    createTeam("Lambda", "lambda");
    const key = keyFor("lambda");
    const req = new Request("http://gate.test/api/v1/me", {
      headers: { authorization: `Bearer ${key}`, [VERSION_HEADERS.client]: "0.1.0" },
    });
    const refused = requireClient(req);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(426);
    const body = await (refused as Response).json();
    expect(body.code).toBe("CLIENT_TOO_OLD");
    expect(body.error).toContain("/plugin update");
  });

  it("serves a client at or above the minimum", () => {
    createTeam("Mu", "mu");
    const req = new Request("http://gate.test/api/v1/me", {
      headers: { authorization: `Bearer ${keyFor("mu")}`, [VERSION_HEADERS.client]: MIN_CLIENT_VERSION },
    });
    expect(requireClient(req)).not.toBeInstanceOf(Response);
  });
});

describe("run ownership", () => {
  it("lets a teammate see a run but only its owner report on it", () => {
    const mine = { teamId: "kappa", userId: "u1" };
    expect(ownsExecution(mine, { keyId: "k", userId: "u1", teamId: "kappa", scopes: ["workflows"] })).toBe(true);
    expect(ownsExecution(mine, { keyId: "k", userId: "u2", teamId: "kappa", scopes: ["workflows"] })).toBe(false);
    expect(ownsExecution(mine, { keyId: "k", userId: "u1", teamId: "other", scopes: ["workflows"] })).toBe(false);
  });

  it("records where a run happened and who it belongs to", () => {
    createExecution("local-run-1", "solo-flow", {}, 1000, null, {
      origin: "local",
      userId: "u1",
      teamId: "alpha",
      client: { host: "laptop-1", repo: "/src/thing", branch: null, version: "0.13.0" },
    });
    const run = getExecution("local-run-1")!;
    expect(run.origin).toBe("local");
    expect(run.teamId).toBe("alpha");
    expect(run.client).toMatchObject({ host: "laptop-1", repo: "/src/thing" });
  });
});
