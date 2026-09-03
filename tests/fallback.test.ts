import { afterEach, describe, expect, it, vi } from "vitest";

import { sendWithFallback } from "@/lib/gateway-core";
import { routeModel } from "@/lib/router";
import { saveSettings } from "@/lib/settings";
import type { StoredCredentials } from "@/lib/store";

const creds: StoredCredentials = {
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: Date.now() + 3_600_000,
  cliUserID: "a".repeat(64),
  account: null,
  connectedAt: 0,
  updatedAt: 0,
};

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

afterEach(() => vi.unstubAllGlobals());

describe("sendWithFallback", () => {
  it("returns an account-wide 429 immediately — no retries, no tier fallback", async () => {
    saveSettings({ retry: { maxRetries: 2, maxRateLimitWaitMs: 5000 }, fallback: { enabled: true } });
    const calls = mockFetch([{ status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "1800" } }]);
    const route = routeModel("fable", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, creds });
    expect(r.upstream.status).toBe(429);
    expect(r.attempts).toBe(1);
    expect(r.usedTier).toBe("fable");
    expect(calls).toEqual(["claude-fable-5-1"]);
  });

  it("falls back to the next tier on a model-specific overload (529)", async () => {
    saveSettings({ retry: { maxRetries: 0, maxRateLimitWaitMs: 5000 }, fallback: { enabled: true } });
    const calls = mockFetch([{ status: 529 }, { status: 200 }]);
    const route = routeModel("opus", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, creds });
    expect(r.upstream.status).toBe(200);
    expect(r.usedTier).toBe("sonnet");
    expect(calls).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("retries transient 5xx with backoff before giving up", async () => {
    saveSettings({ retry: { maxRetries: 1, maxRateLimitWaitMs: 5000 }, fallback: { enabled: false } });
    const calls = mockFetch([{ status: 503 }, { status: 200 }]);
    const route = routeModel("haiku", { messages: [{ role: "user", content: "x" }] });
    const r = await sendWithFallback({ body: { model: route.model, messages: [] }, route, creds });
    expect(r.upstream.status).toBe(200);
    expect(r.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });
});
