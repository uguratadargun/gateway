import { afterEach, describe, expect, it } from "vitest";

import { createKey, deleteKey, listKeys } from "@/lib/apikeys";
import { gatePrincipal, INTERNAL_KEY_ID, LOCAL_KEY_ID } from "@/lib/gate-auth";
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
