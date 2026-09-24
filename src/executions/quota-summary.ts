import { getDb } from "@/lib/db";
import { costForUsage, tierOf } from "@/lib/pricing";

import type { ExecutionQuota, ExecutionTokens } from "./quota";

/**
 * Reading a run's consumption off the database. Server-only — it opens SQLite,
 * so it must never be pulled into a client bundle; the arithmetic the browser
 * needs lives in quota.ts.
 */

interface StepUsageRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** Exact, when the step's usage spanned models and was priced per model. */
  cost_usd: number | null;
}

/** Sums the run's own steps. Called when the run settles. */
export function summarizeExecutionQuota(executionId: string): ExecutionQuota {
  const steps = getDb()
    .prepare(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens, cost_usd
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
    // A step priced when it was attributed carries the exact figure; the
    // tokens above name one model and could not restate a sum across several.
    costUsd +=
      s.cost_usd ??
      costForUsage(tierOf(s.model), { input: s.input_tokens, output: s.output_tokens, cacheRead: s.cache_read_tokens }, { model: s.model });
  }

  return { tokens, costUsd };
}
