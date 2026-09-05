import { getDb } from "@/lib/db";
import { costForUsage, tierOf } from "@/lib/pricing";
import { readRateLimit } from "@/lib/ratelimit";

import type { ExecutionQuota, ExecutionTokens, QuotaCalibration } from "./quota";

/**
 * Reading a run's consumption off the database. Server-only — it opens SQLite,
 * so it must never be pulled into a client bundle; the arithmetic the browser
 * needs lives in quota.ts.
 */

const HOUR = 3_600_000;

interface StepUsageRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

interface UsageRow {
  tier: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** Cost of every gateway request since `since`, by the same price model. */
function gatewayCostSince(since: number): number {
  const rows = getDb()
    .prepare(
      `SELECT tier, model, input_tokens, output_tokens,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens
         FROM usage WHERE ts >= ?`,
    )
    .all(since) as unknown as UsageRow[];
  let total = 0;
  for (const r of rows) {
    total += costForUsage(tierOf(r.model || r.tier), {
      input: r.input_tokens,
      output: r.output_tokens,
      cacheRead: r.cache_read_tokens,
      cacheCreation: r.cache_creation_tokens,
    }, { model: r.model });
  }
  return total;
}

/**
 * Sums the run's own steps and takes the calibration it will be read against.
 * Called when the run settles, so the windows are as its last call left them.
 */
export function summarizeExecutionQuota(executionId: string, at = Date.now()): ExecutionQuota {
  const steps = getDb()
    .prepare(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens
         FROM workflow_execution_steps WHERE execution_id = ?`,
    )
    .all(executionId) as unknown as StepUsageRow[];

  const tokens: ExecutionTokens = { input: 0, output: 0, cacheRead: 0 };
  let costUsd = 0;
  for (const s of steps) {
    if (!s.model) continue; // command and condition nodes cost nothing
    tokens.input += s.input_tokens;
    tokens.output += s.output_tokens;
    tokens.cacheRead += s.cache_read_tokens;
    costUsd += costForUsage(
      tierOf(s.model),
      { input: s.input_tokens, output: s.output_tokens, cacheRead: s.cache_read_tokens },
      { model: s.model },
    );
  }

  const snap = readRateLimit();
  const calibration: QuotaCalibration | null =
    snap && (snap.utilization5h != null || snap.utilization7d != null)
      ? {
          at: snap.updatedAt,
          util5h: snap.utilization5h,
          util7d: snap.utilization7d,
          cost5hUsd: gatewayCostSince(at - 5 * HOUR),
          cost7dUsd: gatewayCostSince(at - 7 * 24 * HOUR),
        }
      : null;

  return { tokens, costUsd, calibration };
}
