import { describe, expect, it } from "vitest";

import { formatPoints, quotaShare, type ExecutionQuota } from "@/executions/quota";

/**
 * The arithmetic that turns a run's own cost into a share of a rate-limit
 * window. It is an attribution, not a measurement, so what matters is that it
 * stays about this run and never claims more of a window than exists.
 */

const quota = (costUsd: number, calibration: ExecutionQuota["calibration"]): ExecutionQuota => ({
  tokens: { input: 1000, output: 100, cacheRead: 0 },
  costUsd,
  calibration,
});

const calibration = {
  at: 0,
  util5h: 0.4,
  util7d: 0.1,
  cost5hUsd: 10,
  cost7dUsd: 100,
};

describe("quota share", () => {
  it("gives the run its cost-weighted slice of each window", () => {
    // $1 of the $10 that went through the window, which stands at 40%.
    const share = quotaShare(quota(1, calibration))!;
    expect(share.fiveHour).toBeCloseTo(4, 6);
    // $1 of the $100 in the weekly window, which stands at 10%.
    expect(share.weekly).toBeCloseTo(0.1, 6);
    expect(share.at5hPct).toBeCloseTo(40, 6);
  });

  it("does not depend on what else ran at the same time", () => {
    // Twice the traffic in the window and twice the utilisation: the same run
    // still accounts for the same slice.
    const busy = quotaShare(quota(1, { ...calibration, util5h: 0.8, cost5hUsd: 20 }))!;
    expect(busy.fiveHour).toBeCloseTo(4, 6);
  });

  it("never claims more of a window than the window holds", () => {
    // Usage rows can lag behind the run that produced them.
    const share = quotaShare(quota(50, calibration))!;
    expect(share.fiveHour).toBeCloseTo(40, 6);
  });

  it("says nothing when there is nothing to say", () => {
    expect(quotaShare(null)).toBeNull();
    expect(quotaShare(quota(1, null))).toBeNull();
    // A run with no model calls has no slice of anything.
    expect(quotaShare(quota(0, calibration))!.fiveHour).toBeNull();
    // A window the API did not report stays unreported.
    expect(quotaShare(quota(1, { ...calibration, util7d: null }))!.weekly).toBeNull();
  });

  it("keeps a small share visible instead of rounding it to zero", () => {
    expect(formatPoints(0.004)).toBe("<0.01 pts");
    expect(formatPoints(0.42)).toBe("0.42 pts");
    expect(formatPoints(12.34)).toBe("12.3 pts");
    expect(formatPoints(0)).toBe("0 pts");
  });
});
