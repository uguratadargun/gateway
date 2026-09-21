import { afterEach, describe, expect, it } from "vitest";

import { createKey, deleteKey, listKeys, type Principal } from "@/lib/apikeys";
import { gatePrincipal, INTERNAL_KEY_ID, LOCAL_KEY_ID } from "@/lib/gate-auth";
import { withRunToken } from "@/lib/run-tokens";
import { createUser, deleteUser, ensureDefaultTeam, DEFAULT_TEAM_ID } from "@/lib/teams";

/**
 * The contract the three gateway routes rely on: `gatePrincipal` hands back
 * who is calling, not merely whether anyone is. Everything the traffic log
 * says about a caller comes from these four scalars.
 */

function request(token?: string): Request {
  return new Request("https://gate.test/api/gateway/v1/messages", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

afterEach(() => {
  for (const k of listKeys()) deleteKey(k.id);
  delete process.env.GATE_API_KEY;
});

describe("who the gateway says is calling", () => {
  it("names the key and the person behind it", () => {
    ensureDefaultTeam();
    const user = createUser({ email: "grace@example.test", name: "Grace", teamId: DEFAULT_TEAM_ID });
    const { key, plaintext } = createKey({ name: "grace-laptop", userId: user.id, teamId: DEFAULT_TEAM_ID });

    const principal = gatePrincipal(request(plaintext));
    expect(principal).toMatchObject({ keyId: key.id, userId: user.id, teamId: DEFAULT_TEAM_ID });

    deleteUser(user.id);
  });

  it("refuses an unknown key once any key exists", () => {
    createKey({ name: "someone-else" });
    expect(gatePrincipal(request("gate_nope"))).toBeNull();
  });

  it("is the local sentinel when no key is issued and none is configured", () => {
    expect(gatePrincipal(request())?.keyId).toBe(LOCAL_KEY_ID);
  });

  it("keeps the two sentinels apart from any key a gate can mint", () => {
    // createKey ids are sixteen hex characters, so neither sentinel can be one.
    for (const sentinel of [LOCAL_KEY_ID, INTERNAL_KEY_ID]) {
      expect(sentinel).not.toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

/**
 * A run's own token is the other way in, and the rest of this file is why it
 * has to exist: on a gate that has issued any key, a request without one is
 * refused whatever its source address — including a request from gate's own
 * child process, running on the same machine.
 */
describe("a run's own token at the gateway", () => {
  const principal: Principal = {
    keyId: INTERNAL_KEY_ID,
    userId: "u-1",
    teamId: DEFAULT_TEAM_ID,
    scopes: ["gateway"],
  };

  it("answers as the run's person and team on a gate that has issued keys", async () => {
    createKey({ name: "someone-else" });

    await withRunToken("exec-1", principal, async (token) => {
      const seen = gatePrincipal(request(token));
      expect(seen).toMatchObject({ keyId: INTERNAL_KEY_ID, userId: "u-1", teamId: DEFAULT_TEAM_ID });
      // The gateway and nothing else: a run token must never reach /api/v1/*.
      expect(seen?.scopes).toEqual(["gateway"]);
    });
  });

  it("wins where GATE_API_KEY is set to something else", async () => {
    process.env.GATE_API_KEY = "an-operator-key";

    await withRunToken("exec-2", principal, async (token) => {
      expect(gatePrincipal(request(token))?.keyId).toBe(INTERNAL_KEY_ID);
    });
  });

  it("dies with the run, however the run ended", async () => {
    // With a key issued, a token nobody holds is refused outright — which is
    // the gate this change is for. On a gate with no keys the request falls
    // through to the local sentinel, as it always has.
    createKey({ name: "someone-else" });

    let settled = "";
    await withRunToken("exec-3", principal, async (token) => {
      settled = token;
    });
    expect(gatePrincipal(request(settled))).toBeNull();

    let thrown = "";
    await expect(
      withRunToken("exec-4", principal, async (token) => {
        thrown = token;
        throw new Error("the run crashed");
      }),
    ).rejects.toThrow("the run crashed");
    expect(gatePrincipal(request(thrown))).toBeNull();
  });

  it("does not replace the caller for a token this process never minted", async () => {
    expect(gatePrincipal(request("gate_run_deadbeef"))?.keyId).not.toBe(INTERNAL_KEY_ID);
    createKey({ name: "someone-else" });
    expect(gatePrincipal(request("gate_run_deadbeef"))).toBeNull();
  });

  it("writes no key while a run is in flight", async () => {
    await withRunToken("exec-5", principal, async () => {
      expect(listKeys()).toHaveLength(0);
    });
  });

  it("carries the run's own id on the principal it resolves to", async () => {
    await withRunToken("exec-6", principal, async (token) => {
      expect(gatePrincipal(request(token))?.executionId).toBe("exec-6");
    });

    const { key, plaintext } = createKey({ name: "not-a-run", userId: "u-2", teamId: DEFAULT_TEAM_ID });
    const seen = gatePrincipal(request(plaintext));
    expect(seen?.keyId).toBe(key.id);
    expect(seen?.executionId ?? null).toBeNull();
  });
});
