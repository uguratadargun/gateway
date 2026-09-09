import { describe, expect, it } from "vitest";

import {
  BACKOFF,
  accountHealth,
  computeCooldown,
  eligibleAccounts,
  exhaustedWindowReset,
  mergeQuota,
  parseUnifiedRateLimitHeaders,
  poolQuota,
  quotaBlockedWindow,
  selectAccount,
  utilizationOf,
  windowLabel,
  type AccountPoolConfig,
} from "@/lib/account-pool";
import type { Account } from "@/lib/accounts";
import { _resetQuotaPollState, parseClaudeUsagePayload, quotaIsStale, shouldPollQuota } from "@/lib/claude/usage";

const CONFIG: AccountPoolConfig = {
  strategy: "fill-first",
  stickyRoundRobinLimit: 3,
  quotaMinRemainingPercent: 0,
};

function account(patch: Partial<Account> & { id: string }): Account {
  return {
    label: patch.id,
    accountUuid: patch.id,
    email: null,
    organization: null,
    planTier: null,
    enabled: true,
    priority: 100,
    lastUsedAt: null,
    consecutiveUseCount: 0,
    backoffLevel: 0,
    cooldownUntil: null,
    lastError: null,
    quota: null,
    quotaFetchedAt: null,
    connectedAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe("eligibility", () => {
  it("drops disabled, cooling-down, and excluded accounts", () => {
    const now = 1_000_000;
    const pool = [
      account({ id: "ok" }),
      account({ id: "off", enabled: false }),
      account({ id: "cooling", cooldownUntil: now + 60_000 }),
      account({ id: "expired-cooldown", cooldownUntil: now - 1 }),
      account({ id: "excluded" }),
    ];
    const ids = eligibleAccounts(pool, CONFIG, new Set(["excluded"]), now).map((a) => a.id);
    expect(ids).toEqual(["ok", "expired-cooldown"]);
  });

  it("skips an account under the remaining-quota floor, but not past its reset", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    const config = { ...CONFIG, quotaMinRemainingPercent: 10 };
    const low = account({
      id: "low",
      quota: { windows: { five_hour: { utilization: 95, resetsAt: new Date(now + 3_600_000).toISOString() } }, source: "headers" },
    });
    const reset = account({
      id: "reset",
      // Same 95% reading, but the window it describes is already over.
      quota: { windows: { five_hour: { utilization: 95, resetsAt: new Date(now - 1).toISOString() } }, source: "headers" },
    });
    expect(quotaBlockedWindow(low, config, now)).toBe("five_hour");
    expect(quotaBlockedWindow(reset, config, now)).toBeNull();
    expect(eligibleAccounts([low, reset], config, new Set(), now).map((a) => a.id)).toEqual(["reset"]);
  });

  it("reads the 5h window as a 0..1 fraction for the throttle", () => {
    const now = 1_000_000;
    const a = account({ id: "a", quota: { windows: { five_hour: { utilization: 82.5, resetsAt: null } } , source: "headers" } });
    expect(utilizationOf(a, now)).toBeCloseTo(0.825);
    expect(utilizationOf(account({ id: "b" }), now)).toBeNull();
  });
});

describe("selection strategies", () => {
  it("fill-first stays on the highest-priority account", () => {
    const pool = [account({ id: "b", priority: 200 }), account({ id: "a", priority: 100 })];
    expect(selectAccount(pool, CONFIG).account?.id).toBe("a");
  });

  it("least-used takes the account idle longest, never-used first", () => {
    const pool = [
      account({ id: "recent", lastUsedAt: 900 }),
      account({ id: "old", lastUsedAt: 100 }),
      account({ id: "fresh" }),
    ];
    const pick = selectAccount(pool, { ...CONFIG, strategy: "least-used" });
    expect(pick.account?.id).toBe("fresh");
    expect(pick.commit).toEqual({ accountId: "fresh", consecutiveUseCount: 1 });
  });

  it("round-robin sticks for the configured run, then rotates to the LRU account", () => {
    const config = { ...CONFIG, strategy: "round-robin" as const, stickyRoundRobinLimit: 3 };
    const sticky = selectAccount(
      [account({ id: "a", lastUsedAt: 900, consecutiveUseCount: 1 }), account({ id: "b", lastUsedAt: 100 })],
      config,
    );
    expect(sticky.account?.id).toBe("a");
    expect(sticky.commit?.consecutiveUseCount).toBe(2);

    const rotated = selectAccount(
      [account({ id: "a", lastUsedAt: 900, consecutiveUseCount: 3 }), account({ id: "b", lastUsedAt: 100 })],
      config,
    );
    expect(rotated.account?.id).toBe("b");
    expect(rotated.commit?.consecutiveUseCount).toBe(1);
  });

  it("a retry never sticks — it goes straight to another account", () => {
    const config = { ...CONFIG, strategy: "round-robin" as const };
    const pick = selectAccount(
      [account({ id: "a", lastUsedAt: 900, consecutiveUseCount: 1 }), account({ id: "b", lastUsedAt: 100 })],
      config,
      { isRetry: true },
    );
    expect(pick.account?.id).toBe("b");
  });

  it("reports no candidate rather than serving a cooling-down account", () => {
    const now = 1_000_000;
    const pool = [account({ id: "a", cooldownUntil: now + 1000 })];
    expect(selectAccount(pool, CONFIG, { now }).account).toBeNull();
  });

  it("scores health down for backoff, errors and a full window", () => {
    const now = 1_000_000;
    expect(accountHealth(account({ id: "clean" }), now)).toBe(100);
    expect(accountHealth(account({ id: "hurt", backoffLevel: 2, lastError: "429" }), now)).toBe(60);
    expect(accountHealth(account({ id: "cool", cooldownUntil: now + 1 }), now)).toBe(70);
  });
});

describe("cooldown", () => {
  it("honours an upstream Retry-After above anything it would compute", () => {
    const d = computeCooldown({ status: 429, quotaExhausted: true, retryAfterSeconds: 90, backoffLevel: 4 });
    expect(d.cooldownMs).toBe(90_000);
    expect(d.newBackoffLevel).toBe(0);
  });

  it("waits for the window reset when the quota is exhausted", () => {
    const now = 1_000_000;
    const d = computeCooldown({
      status: 429,
      quotaExhausted: true,
      retryAfterSeconds: null,
      backoffLevel: 0,
      quotaResetAt: new Date(now + 600_000).toISOString(),
      now,
    });
    expect(d.cooldownMs).toBe(600_000);
    expect(d.reason).toBe("quota window reset");
  });

  it("backs off exponentially, capped, for a plain rate limit", () => {
    const first = computeCooldown({ status: 429, quotaExhausted: false, retryAfterSeconds: null, backoffLevel: 0 });
    expect(first.cooldownMs).toBeGreaterThanOrEqual(BACKOFF.baseMs);
    expect(first.newBackoffLevel).toBe(1);
    const deep = computeCooldown({ status: 429, quotaExhausted: false, retryAfterSeconds: null, backoffLevel: 12 });
    expect(deep.cooldownMs).toBeLessThanOrEqual(BACKOFF.maxMs + 1000);
  });

  it("does not park an account for a non-retryable status", () => {
    expect(computeCooldown({ status: 400, quotaExhausted: false, retryAfterSeconds: null, backoffLevel: 0 }).cooldownMs).toBe(0);
  });
});

describe("unified rate-limit headers", () => {
  it("reads the 5h/7d utilization and reset pairs", () => {
    const quota = parseUnifiedRateLimitHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": "1789000000",
        "anthropic-ratelimit-unified-7d-utilization": "88",
      }),
    );
    expect(quota?.windows.five_hour.utilization).toBe(42);
    expect(quota?.windows.five_hour.resetsAt).toBe(new Date(1789000000 * 1000).toISOString());
    // Tolerant of both the 0..1 fraction and a straight percentage.
    expect(quota?.windows.seven_day.utilization).toBe(88);
  });

  it("returns null when the response carried no unified headers", () => {
    expect(parseUnifiedRateLimitHeaders(new Headers({ "retry-after": "30" }))).toBeNull();
  });

  it("merges only when a reading actually moved", () => {
    const previous = { windows: { five_hour: { utilization: 40, resetsAt: null } }, source: "headers" as const };
    expect(mergeQuota(previous, { windows: { five_hour: { utilization: 40, resetsAt: null } }, source: "headers" })).toBeNull();
    const moved = mergeQuota(previous, { windows: { five_hour: { utilization: 41, resetsAt: null } }, source: "headers" });
    expect(moved?.windows.five_hour.utilization).toBe(41);
  });

  it("finds the soonest reset among exhausted windows", () => {
    const now = 1_000_000;
    const soon = new Date(now + 60_000).toISOString();
    const later = new Date(now + 600_000).toISOString();
    const quota = {
      windows: {
        five_hour: { utilization: 100, resetsAt: later },
        seven_day: { utilization: 99.5, resetsAt: soon },
        // Not exhausted: ignored even though it resets first.
        other: { utilization: 10, resetsAt: new Date(now + 1).toISOString() },
      },
      source: "headers" as const,
    };
    expect(exhaustedWindowReset(quota, now)).toBe(soon);
  });
});

describe("what the pool has left", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const in1h = new Date(now + 3_600_000).toISOString();
  const in3d = new Date(now + 3 * 86_400_000).toISOString();

  function withWindows(id: string, windows: Record<string, { utilization: number; resetsAt: string | null }>, patch: Partial<Account> = {}) {
    return account({ id, quota: { windows, source: "headers" }, quotaFetchedAt: now - 60_000, ...patch });
  }

  it("reports the best account that can serve, not an average", () => {
    const pool = [
      withWindows("spent", { five_hour: { utilization: 95, resetsAt: in1h } }),
      withWindows("fresh", { five_hour: { utilization: 20, resetsAt: in1h } }),
    ];
    const quota = poolQuota(pool, CONFIG, now);
    // Averaging these two would say 42% left, and a request would still be
    // served by the fresh account's window.
    expect(quota.windows).toEqual([{ name: "five_hour", remaining: 80, resetsAt: in1h }]);
    expect(quota.accounts).toEqual({ total: 2, enabled: 2, available: 2, coolingDown: 0, quotaBlocked: 0 });
  });

  it("reads a window whose reset has passed as full again", () => {
    const stale = withWindows("stale", { five_hour: { utilization: 98, resetsAt: new Date(now - 1).toISOString() } });
    expect(poolQuota([stale], CONFIG, now).windows).toEqual([{ name: "five_hour", remaining: 100, resetsAt: null }]);
  });

  it("falls back to the enabled accounts when none can serve, so the reset is still reported", () => {
    const pool = [
      withWindows("cooling", { five_hour: { utilization: 100, resetsAt: in1h } }, { cooldownUntil: now + 60_000 }),
      account({ id: "paused", enabled: false }),
    ];
    const quota = poolQuota(pool, CONFIG, now);
    expect(quota.windows).toEqual([{ name: "five_hour", remaining: 0, resetsAt: in1h }]);
    expect(quota.accounts).toEqual({ total: 2, enabled: 1, available: 0, coolingDown: 1, quotaBlocked: 0 });
  });

  it("counts an account the floor holds back, and reports the floor", () => {
    const config = { ...CONFIG, quotaMinRemainingPercent: 10 };
    const pool = [withWindows("low", { five_hour: { utilization: 95, resetsAt: in1h } })];
    const quota = poolQuota(pool, config, now);
    expect(quota.accounts.available).toBe(0);
    expect(quota.accounts.quotaBlocked).toBe(1);
    expect(quota.floorPercent).toBe(10);
    // 5% left is a true reading; the floor is why it serves nobody.
    expect(quota.windows).toEqual([{ name: "five_hour", remaining: 5, resetsAt: in1h }]);
  });

  it("orders 5h, then 7d, then the per-model windows, and names the plan", () => {
    const one = account({
      id: "one",
      quotaFetchedAt: now - 60_000,
      quota: {
        // Out of order on purpose: the payload's key order is not the reading order.
        windows: {
          seven_day_opus: { utilization: 50, resetsAt: in3d },
          seven_day: { utilization: 10, resetsAt: in3d },
          five_hour: { utilization: 25, resetsAt: in1h },
        },
        source: "headers",
        plan: "max_20x",
      },
    });
    const quota = poolQuota([one], CONFIG, now);
    expect(quota.windows.map((w) => w.name)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(quota.windows.map((w) => windowLabel(w.name))).toEqual(["5h", "7d", "7d opus"]);
    expect(quota.plan).toBe("max_20x");
    expect(quota.updatedAt).toBe(now - 60_000);
  });

  it("says why there is nothing to show rather than showing zero", () => {
    expect(poolQuota([], CONFIG, now).reason).toMatch(/no Claude account/);
    expect(poolQuota([account({ id: "off", enabled: false })], CONFIG, now).reason).toMatch(/paused/);
    expect(poolQuota([account({ id: "new" })], CONFIG, now).reason).toMatch(/no window reading yet/);
    const failed = account({ id: "failed", quota: { windows: {}, source: "usage-endpoint", error: "HTTP 429" } });
    expect(poolQuota([failed], CONFIG, now).reason).toMatch(/HTTP 429/);
  });
});

describe("claude usage endpoint", () => {
  it("reads the five_hour / seven_day windows and the plan", () => {
    const quota = parseClaudeUsagePayload({
      five_hour: { utilization: 37.5, resets_at: "2026-09-08T16:00:00Z" },
      seven_day: { utilization: 12, resets_at: 1789000000 },
      seven_day_opus: { utilization: 4, resets_at: null },
      tier: "max_20x",
      // Not a window: must not become one.
      account_uuid: "abc",
    })!;
    expect(Object.keys(quota.windows).sort()).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(quota.windows.five_hour).toEqual({ utilization: 37.5, resetsAt: "2026-09-08T16:00:00.000Z" });
    expect(quota.windows.seven_day.resetsAt).toBe(new Date(1789000000 * 1000).toISOString());
    expect(quota.plan).toBe("max_20x");
    expect(quota.source).toBe("usage-endpoint");
  });

  it("returns null when the payload carries no window", () => {
    expect(parseClaudeUsagePayload({ tier: "pro" })).toBeNull();
    expect(parseClaudeUsagePayload(null)).toBeNull();
  });

  it("ignores a placeholder plan name", () => {
    expect(parseClaudeUsagePayload({ five_hour: { utilization: 1 }, tier: "Claude Code" })?.plan).toBeNull();
  });

  it("treats a never-polled account as stale, and a fresh one as current", () => {
    const now = 1_000_000_000;
    expect(quotaIsStale(account({ id: "new" }), 5, now)).toBe(true);
    expect(quotaIsStale(account({ id: "fresh", quotaFetchedAt: now - 60_000 }), 5, now)).toBe(false);
    expect(quotaIsStale(account({ id: "aged", quotaFetchedAt: now - 6 * 60_000 }), 5, now)).toBe(true);
  });

  it("polls a never-polled account on any interval, and an aged one only on its own", () => {
    _resetQuotaPollState();
    const now = 1_000_000_000;
    // Infinity is what the dashboard passes: fill in a brand-new account, and
    // leave every periodic refresh to the daemon.
    expect(shouldPollQuota(account({ id: "new" }), Infinity, now)).toBe(true);
    expect(shouldPollQuota(account({ id: "aged", quotaFetchedAt: now - 60 * 60_000 }), Infinity, now)).toBe(false);
    expect(shouldPollQuota(account({ id: "aged", quotaFetchedAt: now - 60 * 60_000 }), 30, now)).toBe(true);
  });

  it("does not re-poll an account whose reply carried fresh headers", () => {
    _resetQuotaPollState();
    const now = 1_000_000_000;
    // captureQuota stamps the same timestamp, so a busy account is never stale
    // and the endpoint is never asked about it at all.
    expect(shouldPollQuota(account({ id: "busy", quotaFetchedAt: now - 60_000 }), 30, now)).toBe(false);
  });
});
