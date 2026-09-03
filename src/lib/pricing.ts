/**
 * Anthropic list pricing per 1M tokens (USD), September 2026:
 * platform.claude.com/docs/en/about-claude/pricing. On a subscription the real
 * cost is flat; these give an API-equivalent proxy and drive "savings".
 */
export type Tier = "haiku" | "sonnet" | "opus" | "fable";

const PRICE_PER_MTOK: Record<Tier, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 5, output: 25 },
  fable: { input: 10, output: 50 },
};

export function tierOf(model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}

/** Cost in USD for a given tier and token counts (no cache). */
export function costFor(tier: Tier, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MTOK[tier];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface CostOptions {
  /** Concrete model id — Fable 5.1 / Mythos 5.1 bill cache reads at 2.5%. */
  model?: string;
  /** Cache-write TTL in effect: 5m writes bill 1.25×, 1h writes 2×. */
  cacheTtl?: "5m" | "1h";
}

/** Cache-read multiplier: 0.1× base input, 0.025× on Fable 5.1 / Mythos 5.1. */
export function cacheReadMultiplier(model?: string): number {
  const m = (model ?? "").toLowerCase();
  return /fable-5-1|mythos-5-1/.test(m) ? 0.025 : 0.1;
}

/** Cost including prompt-cache pricing. */
export function costForUsage(tier: Tier, u: TokenUsage, opts: CostOptions = {}): number {
  const p = PRICE_PER_MTOK[tier];
  const writeMult = opts.cacheTtl === "1h" ? 2 : 1.25;
  return (
    (u.input * p.input +
      (u.cacheRead ?? 0) * p.input * cacheReadMultiplier(opts.model) +
      (u.cacheCreation ?? 0) * p.input * writeMult +
      u.output * p.output) /
    1_000_000
  );
}

/**
 * Savings vs. serving everything on Opus: the difference between what the
 * same tokens would cost on Opus and what the routed tier actually cost.
 */
export function savingsVsOpus(tier: Tier, inputTokens: number, outputTokens: number): number {
  return costFor("opus", inputTokens, outputTokens) - costFor(tier, inputTokens, outputTokens);
}
