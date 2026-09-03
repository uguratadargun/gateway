import { describe, expect, it } from "vitest";

import { getAnalytics, getSession, listSessions, recordUsage } from "@/lib/usage";

describe("analytics + sessions (sqlite)", () => {
  it("aligns rows to hourly buckets and yields exactly 25 buckets for 24h", () => {
    const now = Date.now();
    recordUsage({ ts: now - 1000, requested: "auto", model: "claude-sonnet-5", tier: "sonnet", reason: "default", status: 200, stream: false, inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, sessionId: "s-analytics", sessionTitle: "hello world" });
    recordUsage({ ts: now - 2000, requested: "auto", model: "claude-haiku-4-5-20251001", tier: "haiku", reason: "trivial", status: 200, stream: false, inputTokens: 10, outputTokens: 5, sessionId: "s-analytics" });
    const a = getAnalytics("24h");
    expect(a.bucketMs).toBe(3600_000);
    expect(a.buckets.length).toBe(25);
    for (const b of a.buckets) expect(b.ts % 3600_000).toBe(0);
    const last = a.buckets.at(-1)!;
    expect(last.requests).toBeGreaterThanOrEqual(2);
    expect(last.byTier.sonnet.tokens).toBe(450);
    expect(a.totals.cacheHitRatio).toBeGreaterThan(0);
    expect(a.byModel.map((m) => m.model)).toContain("claude-sonnet-5");
  });

  it("groups usage into sessions with title, cost, and cached tokens", () => {
    const s = listSessions().find((x) => x.id === "s-analytics")!;
    expect(s.title).toBe("hello world");
    expect(s.requests).toBe(2);
    expect(s.cacheReadTokens).toBe(300);
    expect(s.cost).toBeGreaterThan(0);
    expect(s.models.sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    const detail = getSession("s-analytics");
    expect(detail.summary?.id).toBe("s-analytics");
    expect(detail.events.length).toBe(2);
  });
});
