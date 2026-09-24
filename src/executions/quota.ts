/**
 * What one run cost.
 *
 * Pure on purpose: the execution page renders this in the browser, so nothing
 * here may reach for the database. Reading the numbers off a run lives in
 * quota-summary.ts, which is server-only.
 *
 * The run's own totals are exact for what its steps recorded: every step that
 * reported usage names the model it used and the tokens it spent, so they sum
 * to this run and nothing else. A node done by the person's own session, or
 * its subagent, reports none — it is on their own Claude plan.
 */

export interface ExecutionTokens {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ExecutionQuota {
  tokens: ExecutionTokens;
  /** API-equivalent cost of this run alone. */
  costUsd: number;
}
