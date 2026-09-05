/**
 * What one run cost, and what that is worth out of the rate-limit windows.
 *
 * Pure on purpose: the execution page renders this in the browser, so nothing
 * here may reach for the database. Reading the numbers off a run lives in
 * quota-summary.ts, which is server-only.
 *
 * The run's own totals are exact: every step records the model it used and the
 * tokens it spent, so they sum to this run and nothing else. Concurrent runs
 * and ordinary Claude Code traffic never enter that sum.
 *
 * The share of the 5-hour and weekly windows cannot be exact, because the API
 * reports only where the windows stand — never what a single request moved
 * them. Reading the account-wide utilisation before and after a run would
 * measure everything else happening at the same time, which is the wrong
 * answer to "what did this run use".
 *
 * So the share is attributed instead of measured: at the moment the run ends,
 * the current utilisation is divided across the gateway traffic inside that
 * window, weighted by cost — which is the model-weighted measure the windows
 * themselves are closest to — and this run takes its slice. It is an estimate,
 * labelled as one, and it is about this run alone.
 */

export interface ExecutionTokens {
  input: number;
  output: number;
  cacheRead: number;
}

export interface QuotaCalibration {
  at: number;
  /** 0..1 utilisation of each window when the run ended. */
  util5h: number | null;
  util7d: number | null;
  /** Gateway cost inside each window at that moment, this run included. */
  cost5hUsd: number;
  cost7dUsd: number;
}

export interface ExecutionQuota {
  tokens: ExecutionTokens;
  /** API-equivalent cost of this run alone. */
  costUsd: number;
  calibration: QuotaCalibration | null;
}

export interface QuotaShare {
  /** Percentage points of the window attributed to this run. */
  fiveHour: number | null;
  weekly: number | null;
  /** Where each window stood when the run ended, in percent. */
  at5hPct: number | null;
  at7dPct: number | null;
}

/**
 * The run's slice of each window. Pure, so the arithmetic that turns a cost
 * into a percentage is testable without a database.
 */
export function quotaShare(quota: ExecutionQuota | null | undefined): QuotaShare | null {
  const c = quota?.calibration;
  if (!quota || !c) return null;

  const slice = (util: number | null, windowCost: number): number | null => {
    if (util == null || windowCost <= 0 || quota.costUsd <= 0) return null;
    // A run cannot account for more of the window than the window holds; the
    // usage rows can lag, and an over-100% share would be nonsense.
    const share = Math.min(quota.costUsd / windowCost, 1);
    return util * 100 * share;
  };

  return {
    fiveHour: slice(c.util5h, c.cost5hUsd),
    weekly: slice(c.util7d, c.cost7dUsd),
    at5hPct: c.util5h == null ? null : c.util5h * 100,
    at7dPct: c.util7d == null ? null : c.util7d * 100,
  };
}

/** "2.8 pts" / "0.04 pts" / "<0.01 pts" — small runs are not rounded away. */
export function formatPoints(points: number): string {
  if (points <= 0) return "0 pts";
  if (points < 0.01) return "<0.01 pts";
  return `${points < 1 ? points.toFixed(2) : points.toFixed(1)} pts`;
}
