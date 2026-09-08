import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, listAccounts, type Account } from "@/lib/accounts";
import { sendWithFallback } from "@/lib/gateway-core";
import { getDb } from "@/lib/db";
import { routeModel } from "@/lib/router";
import { loadSettings, saveSettings } from "@/lib/settings";
import type { ClaudeAccount } from "@/lib/claude/oauth";
import type { StoredCredentials } from "@/lib/store";

function creds(uuid: string): StoredCredentials {
  return {
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: Date.now() + 3_600_000,
    cliUserID: "a".repeat(64),
    account: { account_uuid: uuid, account_email: `${uuid}@example.test` } as ClaudeAccount,
    connectedAt: 0,
    updatedAt: 0,
  };
}

function connect(uuid: string, label = uuid): Account {
  return addAccount(creds(uuid), label);
}

function pool(): { account: Account; pool: Account[]; poolConfig: ReturnType<typeof loadSettings>["accountPool"] } {
  const accounts = listAccounts();
  return { account: accounts[0], pool: accounts, poolConfig: loadSettings().accountPool };
}

function mockFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string).model);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return new Response("{}", { status: r.status, headers: r.headers ?? {} });
    }),
  );
  return calls;
}

beforeEach(() => {
  getDb().exec("DELETE FROM accounts");
  saveSettings({ accountPool: { strategy: "fill-first", quotaMinRemainingPercent: 0 } });
});
afterEach(() => vi.unstubAllGlobals());

describe("sendWithFallback", () => {
  it("returns an account-wide 429 immediately — no retries, no tier fallback", async () => {
    connect("solo");
    saveSettings({ retry: { maxRetries: 2, maxRateLimitWaitMs: 5000 }, fallback: { enabled: true } });
    const calls = mockFetch([
      { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "1800" } },
    ]);
    const route = routeModel("fable", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(r.upstream.status).toBe(429);
    expect(r.attempts).toBe(1);
    expect(r.usedTier).toBe("fable");
    expect(calls).toEqual(["claude-fable-5-1"]);
  });

  it("falls back to the next tier on a model-specific overload (529)", async () => {
    connect("solo");
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 5000 }, fallback: { enabled: true } });
    const calls = mockFetch([{ status: 529 }, { status: 200 }]);
    const route = routeModel("opus", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(r.upstream.status).toBe(200);
    expect(r.usedTier).toBe("sonnet");
    expect(calls).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("retries transient 5xx with backoff before giving up", async () => {
    connect("solo");
    saveSettings({ retry: { maxRetries: 1, maxRateLimitWaitMs: 5000 }, fallback: { enabled: false } });
    const calls = mockFetch([{ status: 503 }, { status: 200 }]);
    const route = routeModel("haiku", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(r.upstream.status).toBe(200);
    expect(r.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("moves to the next account on a rate limit before downgrading the tier", async () => {
    const first = connect("first");
    connect("second");
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    // Same tier twice: the second call is a different account, not a cheaper model.
    const calls = mockFetch([
      { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "1800" } },
      { status: 200 },
    ]);
    const route = routeModel("opus", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(r.upstream.status).toBe(200);
    expect(r.usedTier).toBe("opus");
    expect(calls).toEqual(["claude-opus-5", "claude-opus-5"]);
    expect(r.accountId).not.toBe(first.id);
    // The exhausted account is parked, with the reset time Anthropic gave.
    const cooled = listAccounts().find((a) => a.id === first.id)!;
    expect(cooled.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("stops once every account is exhausted — no tier the same logins can serve", async () => {
    connect("first");
    connect("second");
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    const rejected = { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "1800" };
    const calls = mockFetch([{ status: 429, headers: rejected }, { status: 429, headers: rejected }, { status: 200 }]);
    const route = routeModel("opus", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(calls).toEqual(["claude-opus-5", "claude-opus-5"]);
    expect(r.upstream.status).toBe(429);
  });

  it("keeps a model-specific 429 on the same account and drops a tier instead", async () => {
    const first = connect("first");
    connect("second");
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    // No unified "rejected": the limit is the model's, so the account is fine.
    const calls = mockFetch([{ status: 429, headers: { "retry-after": "1800" } }, { status: 200 }]);
    const route = routeModel("opus", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    expect(calls).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(r.accountId).toBe(first.id);
    // Parking a healthy account here would take it out of the pool for
    // everything else too.
    expect(listAccounts().find((a) => a.id === first.id)!.cooldownUntil).toBeNull();
  });
});
