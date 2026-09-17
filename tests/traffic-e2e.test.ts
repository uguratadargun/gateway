import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, deleteAccount, listAccounts } from "@/lib/accounts";
import { createKey, deleteKey, listKeys } from "@/lib/apikeys";
import type { ClaudeAccount } from "@/lib/claude/oauth";
import { executeMessages } from "@/lib/gateway-core";
import { clearTraffic, readTraffic } from "@/lib/traffic";
import type { StoredCredentials } from "@/lib/store";
import { createUser, deleteUser, ensureDefaultTeam, DEFAULT_TEAM_ID } from "@/lib/teams";

/**
 * The whole way through: a request carrying someone's key leaves a traffic row
 * that names them and the account that served it. Non-streaming only — the
 * streamed path accounts from `after()`, which needs a request context these
 * tests do not have; it reads the same `opts.caller` off the same closure.
 */

const creds = (uuid: string): StoredCredentials => ({
  accessToken: "a",
  refreshToken: "r",
  expiresAt: Date.now() + 3_600_000,
  account: { account_uuid: uuid, account_email: `${uuid}@example.test` } as ClaudeAccount,
  cliUserID: "0".repeat(64),
  connectedAt: 0,
  updatedAt: 0,
});

const body = () => ({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], temperature: 1 });

describe("a served request leaves a row naming its caller", () => {
  beforeEach(() => {
    clearTraffic();
    ensureDefaultTeam();
    for (const a of listAccounts()) deleteAccount(a.id);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of listKeys()) deleteKey(k.id);
    for (const a of listAccounts()) deleteAccount(a.id);
    clearTraffic();
  });

  it("names the person behind the key and the account that answered", async () => {
    const account = addAccount(creds("e2e-account"), "work");
    const user = createUser({ email: "alan@example.test", name: "Alan", teamId: DEFAULT_TEAM_ID });
    const { key } = createKey({ name: "alan-laptop", userId: user.id, teamId: DEFAULT_TEAM_ID });

    await executeMessages(body(), {
      stream: false,
      clientBeta: null,
      effortHeader: null,
      session: { id: null, title: null },
      requestPreview: "{}",
      caller: { keyId: key.id, userId: user.id, teamId: DEFAULT_TEAM_ID, scopes: ["gateway"] },
    });

    const row = readTraffic()[0];
    expect(row.caller).toBe("Alan");
    expect(row.servedBy).toBe("work");
    expect(row.accountId).toBe(account.id);

    deleteUser(user.id);
  });

  it("attributes a call that named no caller as unknown, not as someone else", async () => {
    addAccount(creds("e2e-account-2"), "work");

    await executeMessages(body(), {
      stream: false,
      clientBeta: null,
      effortHeader: null,
      session: { id: null, title: null },
      requestPreview: "{}",
    });

    expect(readTraffic()[0].caller).toBe("unknown");
  });
});
