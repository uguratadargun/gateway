import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, listAccounts, saveAccountQuota, type Account } from "@/lib/accounts";
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

  it("parks a Fable-scoped rejection on the model — the account keeps serving, another login takes Fable", async () => {
    const first = connect("first");
    const second = connect("second");
    // The live shape from 2026-09-18: the weekly Fable window spent, the
    // session and plain weekly windows fine. The reply headers name no window,
    // so the snapshot is what decides.
    saveAccountQuota(first.id, {
      windows: {
        five_hour: { utilization: 39, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: { utilization: 32, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        seven_day_fable: { utilization: 99.7, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), scope: "Fable" },
      },
      source: "usage-endpoint",
      polledAt: Date.now(),
    });
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    const calls = mockFetch([
      { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected" } },
      { status: 200 },
    ]);
    const route = routeModel("fable", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    // Same tier, next account: the model moved, nothing was downgraded.
    expect(r.upstream.status).toBe(200);
    expect(r.usedTier).toBe("fable");
    expect(calls).toEqual(["claude-fable-5-1", "claude-fable-5-1"]);
    expect(r.accountId).toBe(second.id);
    // The account is not cooled down — its 5h window is fine and every other
    // model reads it. The block is, until the window resets.
    const row = listAccounts().find((a) => a.id === first.id)!;
    expect(row.cooldownUntil).toBeNull();
    expect(row.modelBlocks).toEqual([
      { window: "seven_day_fable", scope: "Fable", until: expect.any(Number) },
    ]);
    expect(row.modelBlocks[0].until).toBeGreaterThan(Date.now());
    expect(listAccounts().find((a) => a.id === second.id)!.modelBlocks).toEqual([]);
  });

  it("with every account Fable-blocked, a Fable request walks down the tier chain", async () => {
    const first = connect("first");
    const second = connect("second");
    for (const a of [first, second]) {
      saveAccountQuota(a.id, {
        windows: {
          five_hour: { utilization: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
          seven_day: { utilization: 10, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          seven_day_fable: { utilization: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), scope: "Fable" },
        },
        source: "usage-endpoint",
        polledAt: Date.now(),
      });
    }
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    const rejected = { "anthropic-ratelimit-unified-status": "rejected" };
    const calls = mockFetch([
      { status: 429, headers: rejected },
      { status: 429, headers: rejected },
      { status: 200 },
    ]);
    const route = routeModel("fable", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    // Both logins refused Fable, so the chain dropped a rung — Opus reads a
    // different window, and the same logins serve it.
    expect(r.upstream.status).toBe(200);
    expect(r.usedTier).toBe("opus");
    expect(calls).toEqual(["claude-fable-5-1", "claude-fable-5-1", "claude-opus-5"]);
    expect(r.accountId).toBe(first.id);
    // And nobody was parked account-wide: no cooldown anywhere, one block each.
    for (const a of listAccounts()) {
      expect(a.cooldownUntil).toBeNull();
      expect(a.modelBlocks.map((b) => b.window)).toEqual(["seven_day_fable"]);
    }
  });

  it("a model block is on the row, so a restart keeps it", async () => {
    const solo = connect("solo");
    saveAccountQuota(solo.id, {
      windows: {
        five_hour: { utilization: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day_fable: { utilization: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), scope: "Fable" },
      },
      source: "usage-endpoint",
      polledAt: Date.now(),
    });
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 0 }, fallback: { enabled: true } });
    mockFetch([
      { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected" } },
      { status: 200 },
    ]);
    const route = routeModel("fable", { messages: [{ role: "user", content: "x" }] });
    await sendWithFallback({ body: { model: route.model, messages: [] }, route, stream: false, ...pool() });
    // A fresh read — what a restarted gate's listAccounts loads — carries the
    // block and no cooldown.
    const reread = listAccounts().find((a) => a.id === solo.id)!;
    expect(reread.modelBlocks).toEqual([{ window: "seven_day_fable", scope: "Fable", until: expect.any(Number) }]);
    expect(reread.cooldownUntil).toBeNull();
  });
});
