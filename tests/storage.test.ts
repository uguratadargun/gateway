import { describe, expect, it } from "vitest";

import { createKey, deleteKey, hasActiveKeys, listKeys, revokeKey, verifyKey } from "@/lib/apikeys";
import { cacheClear, cacheGet, cacheKey, cacheSet, cacheStats } from "@/lib/cache";
import { costFor, savingsVsOpus, tierOf } from "@/lib/pricing";
import { readRateLimit, recordRateLimit } from "@/lib/ratelimit";
import type { ClaudeAccount } from "@/lib/claude/oauth";
import { addAccount, deleteAccount, listAccounts, loadAccountCredentials } from "@/lib/accounts";
import type { StoredCredentials } from "@/lib/store";
import { saveSettings } from "@/lib/settings";
import { clearTraffic, readTraffic, recordTraffic } from "@/lib/traffic";
import { getSpend, readUsage, recordUsage } from "@/lib/usage";

describe("pricing", () => {
  it("infers tiers from model ids", () => {
    expect(tierOf("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(tierOf("claude-sonnet-5")).toBe("sonnet");
    expect(tierOf("claude-opus-5")).toBe("opus");
    expect(tierOf("claude-fable-5-1")).toBe("fable");
  });
  it("computes cost and savings vs opus", () => {
    // Sept-2026 list prices: haiku 1/5, opus 5/25 per MTok.
    expect(costFor("haiku", 10_000, 2_000)).toBeCloseTo(0.02);
    expect(costFor("opus", 10_000, 2_000)).toBeCloseTo(0.1);
    expect(savingsVsOpus("haiku", 10_000, 2_000)).toBeCloseTo(0.08);
  });
});

describe("usage (sqlite)", () => {
  it("records events and aggregates totals, cost, and spend windows", () => {
    recordUsage({ ts: Date.now(), requested: "auto", model: "claude-haiku-4-5-20251001", tier: "haiku", reason: "trivial", status: 200, stream: false, inputTokens: 10_000, outputTokens: 2_000 });
    recordUsage({ ts: Date.now(), requested: "auto", model: "claude-opus-5", tier: "opus", reason: "heavy", status: 200, stream: true, inputTokens: 1_000, outputTokens: 100 });
    const u = readUsage();
    expect(u.total).toBe(2);
    expect(u.byTier).toEqual({ haiku: 1, opus: 1 });
    expect(u.inputTokens).toBe(11_000);
    expect(u.cost).toBeCloseTo(0.02 + 0.0075);
    expect(u.recent[0].model).toBeDefined();
    const spend = getSpend();
    expect(spend.today).toBeCloseTo(u.cost);
    expect(spend.month).toBeCloseTo(u.cost);
  });
});

describe("api keys (sqlite)", () => {
  it("creates, verifies, revokes, and deletes keys; hides the hash", () => {
    expect(hasActiveKeys()).toBe(false);
    const { key, plaintext } = createKey("cli");
    expect(plaintext.startsWith("gate_")).toBe(true);
    expect(hasActiveKeys()).toBe(true);
    expect(verifyKey(plaintext)).toBe(true);
    expect(verifyKey("gate_wrong")).toBe(false);
    const listed = listKeys().find((k) => k.id === key.id)!;
    expect((listed as any).hash).toBeUndefined();
    expect(listed.lastUsedAt).not.toBeNull();
    expect(revokeKey(key.id)).toBe(true);
    expect(verifyKey(plaintext)).toBe(false);
    expect(hasActiveKeys()).toBe(false);
    expect(deleteKey(key.id)).toBe(true);
    expect(listKeys().length).toBe(0);
  });
});

describe("cache (sqlite)", () => {
  it("stores and retrieves within TTL, tracks hit rate, and honours disable", () => {
    saveSettings({ cache: { enabled: true, ttlSeconds: 60 } });
    cacheClear();
    const body = { messages: [{ role: "user", content: "2+2" }], max_tokens: 10 };
    const key = cacheKey("claude-sonnet-5", body);
    expect(cacheGet(key)).toBeNull();
    cacheSet(key, { body: '{"ok":1}', model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 });
    expect(cacheGet(key)?.body).toBe('{"ok":1}');
    const s = cacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.entries).toBe(1);
    saveSettings({ cache: { enabled: false } });
    expect(cacheGet(key)).toBeNull();
  });
});

describe("traffic + ratelimit (sqlite)", () => {
  it("records, reads newest-first, and clears traffic", () => {
    clearTraffic();
    recordTraffic({ ts: 1, endpoint: "messages", requested: "a", routed: "m", tier: "haiku", status: 200, stream: false, fromCache: false, requestPreview: "q", responsePreview: "r" });
    recordTraffic({ ts: 2, endpoint: "messages", requested: "b", routed: "m", tier: "haiku", status: 200, stream: false, fromCache: false, requestPreview: "q", responsePreview: "r" });
    const t = readTraffic();
    expect(t.map((e) => e.requested)).toEqual(["b", "a"]);
    clearTraffic();
    expect(readTraffic().length).toBe(0);
  });
  it("persists the latest rate-limit snapshot", () => {
    recordRateLimit(new Headers({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-tokens-remaining": "1234" }));
    const rl = readRateLimit();
    expect(rl?.unifiedStatus).toBe("allowed");
    expect(rl?.raw["anthropic-ratelimit-tokens-remaining"]).toBe("1234");
  });
});

describe("account pool storage", () => {
  const creds = (uuid: string, token = "a"): StoredCredentials => ({
    accessToken: token,
    refreshToken: "r",
    expiresAt: Date.now() + 3_600_000,
    account: { account_uuid: uuid, account_email: `${uuid}@example.test` } as ClaudeAccount,
    cliUserID: "0".repeat(64),
    connectedAt: 0,
    updatedAt: 0,
  });

  it("keeps several logins side by side, each with its own sealed tokens", () => {
    const one = addAccount(creds("account-1"), "personal");
    const two = addAccount(creds("account-2", "b"), "work");
    expect(listAccounts().map((a) => a.label)).toEqual(["personal", "work"]);
    expect(loadAccountCredentials(one.id)?.accessToken).toBe("a");
    expect(loadAccountCredentials(two.id)?.accessToken).toBe("b");
    // Nothing readable leaves the store: the row the dashboard sees has no
    // token fields at all.
    expect(Object.keys(one)).not.toContain("sealed");
    deleteAccount(one.id);
    deleteAccount(two.id);
  });

  it("re-authorizing the same account refreshes it in place, not as a duplicate", () => {
    const first = addAccount(creds("account-1"), "personal");
    const again = addAccount(creds("account-1", "rotated"));
    expect(again.id).toBe(first.id);
    expect(listAccounts().length).toBe(1);
    // Two rows for one Anthropic account would share — and double-count — one
    // quota, and the pool would rotate between two views of the same window.
    expect(loadAccountCredentials(first.id)?.accessToken).toBe("rotated");
    // A re-login is also how a user clears a cooled-down account.
    expect(again.enabled).toBe(true);
    expect(again.cooldownUntil).toBeNull();
    deleteAccount(first.id);
  });

  it("orders the pool by priority, newest login last", () => {
    const a = addAccount(creds("account-1"), "first");
    const b = addAccount(creds("account-2"), "second");
    expect(listAccounts().map((x) => x.id)).toEqual([a.id, b.id]);
    expect(b.priority).toBeGreaterThan(a.priority);
    deleteAccount(a.id);
    deleteAccount(b.id);
  });
});
