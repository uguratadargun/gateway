import { describe, expect, it } from "vitest";

import { addAccount, deleteAccount } from "@/lib/accounts";
import { createKey } from "@/lib/apikeys";
import { nameCaller } from "@/lib/attribution";
import type { ClaudeAccount } from "@/lib/claude/oauth";
import { INTERNAL_KEY_ID, LOCAL_KEY_ID } from "@/lib/gate-auth";
import type { StoredCredentials } from "@/lib/store";
import { createUser, deleteUser, ensureDefaultTeam, DEFAULT_TEAM_ID } from "@/lib/teams";

/**
 * `nameCaller` is where the live feed's naming actually lives — the SSE route
 * that calls it is two lines. It has to produce exactly what `readTraffic`'s
 * join produces, from loose ids instead of a joined row.
 */

describe("nameCaller", () => {
  it("names the person and the account", () => {
    ensureDefaultTeam();
    const user = createUser({ email: "alan@example.test", name: "Alan", teamId: DEFAULT_TEAM_ID });
    const { key } = createKey({ name: "alan-laptop", userId: user.id, teamId: DEFAULT_TEAM_ID });
    const account = addAccount(
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
        account: { account_uuid: "attribution-account", account_email: "work@example.test" } as ClaudeAccount,
        cliUserID: "0".repeat(64),
        connectedAt: 0,
        updatedAt: 0,
      },
      "work",
    );

    expect(nameCaller({ keyId: key.id, userId: user.id, accountId: account.id })).toEqual({
      caller: "Alan",
      servedBy: "work",
    });

    // Deleting the person revokes the key rather than removing it, and a
    // deleted account leaves nothing to look up — the name still degrades.
    deleteAccount(account.id);
    deleteUser(user.id);
    const degraded = nameCaller({ keyId: key.id, userId: user.id, accountId: account.id });
    expect(degraded.caller).toBe("alan-laptop");
    expect(degraded.servedBy).toMatch(/^removed account /);
  });

  it("names the sentinels, and unknown for nothing at all", () => {
    expect(nameCaller({ keyId: LOCAL_KEY_ID })).toEqual({ caller: "local", servedBy: "—" });
    expect(nameCaller({ keyId: INTERNAL_KEY_ID })).toEqual({ caller: "workflow", servedBy: "—" });
    expect(nameCaller({})).toEqual({ caller: "unknown", servedBy: "—" });
  });
});
