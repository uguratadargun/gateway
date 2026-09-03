/**
 * Approximate API-equivalent pricing per 1M tokens (USD). On a subscription the
 * real cost is flat, but pricing the traffic against list rates gives a useful
 * proxy for "what this would have cost on the API" and for routing savings.
 */
export type Tier = "haiku" | "sonnet" | "opus" | "fable";

const PRICE_PER_MTOK: Record<Tier, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  // Estimated — Fable pricing is not public; treated as top-tier for accounting.
  fable: { input: 20, output: 100 },
};

export function tierOf(model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}

/** Cost in USD for a given tier and token counts. */
export function costFor(tier: Tier, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MTOK[tier];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * Savings vs. serving everything on the top tier (Opus): the difference between
 * what the same tokens would cost on Opus and what the routed tier actually cost.
 */
export function savingsVsOpus(
  tier: Tier,
  inputTokens: number,
  outputTokens: number,
): number {
  return costFor("opus", inputTokens, outputTokens) - costFor(tier, inputTokens, outputTokens);
}
