/**
 * Anthropic list pricing per 1M tokens (USD), September 2026:
 * platform.claude.com/docs/en/about-claude/pricing. On a subscription the real
 * cost is flat; these give an API-equivalent figure for a run's recorded steps.
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
 * What a model call would cost at Anthropic's list price, or 0 for a provider
 * model: a vLLM on the gate's own machine is on nobody's Anthropic bill, and
 * pricing it as Sonnet would put a figure on the ledger nobody paid.
 */
export function apiEquivalentCost(model: string, u: TokenUsage): number {
  if (/^(provider|local):/.test(model)) return 0;
  return costForUsage(tierOf(model), u, { model });
}
