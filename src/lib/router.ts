import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeEffort, type Effort } from "./reasoning";

/**
 * Context-aware model router.
 *
 * Picks the concrete Claude model to serve a request from the request's shape:
 * explicit alias mapping first, then heuristics over context size, tool use, and
 * intent keywords. Rules are overridable via ~/.gate/routing.json.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export interface RoutingConfig {
  /** Concrete model ids for each tier. */
  tiers: Record<Tier, string>;
  /** Alias → concrete model (or tier name). Case-insensitive keys. */
  aliases: Record<string, string>;
  /** Approx token thresholds. */
  thresholds: {
    /** At or above this many estimated tokens, escalate to the large-context tier. */
    largeContext: number;
    /** At or below this many tokens with no tools, downgrade to the cheap tier. */
    trivial: number;
    /** Haiku's window is 200K; never send it more than this. */
    haikuContextMax: number;
  };
  /** Cost/quality dial (RouteLLM-style threshold): shifts the grader mapping. */
  preset: RoutingPreset;
  /** LLM difficulty grader for the ambiguous "default" category. */
  classifier: { enabled: boolean; minTokens: number };
  /** Keep model + effort stable within a session (prompt caches are per-model). */
  sticky: { enabled: boolean; minTokens: number };
  /** Lowercased substrings that force the top tier when found in the prompt. */
  heavyKeywords: string[];
  /** Lowercased system/prompt substrings that mark cheap utility traffic. */
  backgroundKeywords: string[];
  /** Default tier when no rule fires. */
  default: Tier;
  /**
   * Which tier serves each difficulty category. This is the user-facing
   * "which model for which difficulty" mapping.
   */
  categories: Record<RouteCategory, Tier>;
  /** Reasoning effort per difficulty category (see reasoning.ts). */
  effort: Record<RouteCategory, RouteEffort>;
  /** When false, an explicit concrete `claude-*` model is always passed through. */
  overrideExplicit: boolean;
}

export type RouteEffort = Effort;
export type RoutingPreset = "economy" | "balanced" | "quality";

/**
 * Presets = the cost/quality dial. Balanced follows Anthropic's Sept-2026
 * guidance for an efficiency-first gateway: Sonnet as the daily driver at
 * medium effort, Haiku for utility traffic at low, the top tier only for
 * explicit heavy intent. Quality moves the daily driver up; Economy keeps
 * everything on Sonnet or below.
 */
export const PRESETS: Record<RoutingPreset, { categories: Record<RouteCategory, Tier>; effort: Record<RouteCategory, RouteEffort> }> = {
  economy: {
    categories: { background: "haiku", trivial: "haiku", agentic: "sonnet", default: "sonnet", largeContext: "sonnet", heavy: "opus" },
    effort: { background: "low", trivial: "low", agentic: "low", default: "low", largeContext: "low", heavy: "medium" },
  },
  balanced: {
    categories: { background: "haiku", trivial: "haiku", agentic: "sonnet", default: "sonnet", largeContext: "sonnet", heavy: "fable" },
    effort: { background: "low", trivial: "low", agentic: "medium", default: "medium", largeContext: "medium", heavy: "high" },
  },
  quality: {
    categories: { background: "haiku", trivial: "sonnet", agentic: "opus", default: "sonnet", largeContext: "sonnet", heavy: "fable" },
    effort: { background: "low", trivial: "medium", agentic: "high", default: "high", largeContext: "high", heavy: "xhigh" },
  },
};

export const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

/**
 * Map a 1–5 difficulty grade (from the Haiku judge) to a tier + effort, shifted
 * by the preset: Economy grades one step easier, Quality one step harder.
 */
export function gradeToRoute(grade: number, cfg: RoutingConfig): { tier: Tier; effort: RouteEffort } {
  const bias = cfg.preset === "economy" ? -1 : cfg.preset === "quality" ? 1 : 0;
  const g = Math.max(1, Math.min(5, Math.round(grade) + bias));
  const table: Record<number, { tier: Tier; effort: RouteEffort }> = {
    1: { tier: "haiku", effort: "low" },
    2: { tier: "haiku", effort: "medium" },
    3: { tier: "sonnet", effort: "medium" },
    4: { tier: "opus", effort: "high" },
    5: { tier: "fable", effort: "high" },
  };
  return table[g];
}

export type RouteCategory =
  | "background"
  | "trivial"
  | "agentic"
  | "largeContext"
  | "heavy"
  | "default";

const DEFAULT_CONFIG: RoutingConfig = {
  tiers: {
    haiku: "claude-haiku-4-5-20251001",
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-5",
    // Mythos-class, above Opus — the most capable model; newest revision.
    fable: "claude-fable-5-1",
  },
  aliases: {
    // Common OpenAI-style names mapped onto tiers, so OpenAI clients work too.
    "gpt-4o-mini": "haiku",
    "gpt-4o": "sonnet",
    "gpt-4": "sonnet",
    "gpt-4-turbo": "sonnet",
    "gpt-4.1": "sonnet",
    "gpt-4.1-mini": "haiku",
    "gpt-5": "opus",
    "gpt-5-mini": "sonnet",
    "gpt-5-nano": "haiku",
    // Reasoning models → strongest reasoning tiers.
    "o1": "opus",
    "o3": "fable",
    "o4-mini": "sonnet",
    // Bare tier names.
    haiku: "haiku",
    sonnet: "sonnet",
    opus: "opus",
    fable: "fable",
    // "auto" is a sentinel: fall through to context-based heuristics.
    auto: "auto",
  },
  thresholds: { largeContext: 180_000, trivial: 500, haikuContextMax: 150_000 },
  preset: "balanced",
  classifier: { enabled: true, minTokens: 300 },
  sticky: { enabled: true, minTokens: 2000 },
  // Only explicit intent phrases. Generic words ("step by step", "prove",
  // "architect" — which also matches "architecture") leaked ordinary prompts
  // onto the top tier with maximum thinking.
  heavyKeywords: ["think hard", "think deeply", "ultrathink", "deep dive"],
  backgroundKeywords: [
    "generate a title",
    "conversation title",
    "one-line summary",
    "short summary",
    "summarize this",
    "suggest a name",
  ],
  default: "sonnet",
  // Best practice: cheapest model that does the job, escalating by difficulty
  // (haiku → sonnet → opus → fable). Sonnet 5 has a 1M window at standard
  // pricing, so large context stays on Sonnet; only Haiku (200K) needs a guard.
  categories: { ...PRESETS.balanced.categories },
  // Effort is the main cost lever (API default is `high`): low for utility
  // traffic, medium as the daily driver, high only for explicit heavy intent.
  effort: { ...PRESETS.balanced.effort },
  overrideExplicit: true,
};

let cached: RoutingConfig | null = null;

export function loadRoutingConfig(): RoutingConfig {
  if (cached) return cached;
  const file = process.env.GATE_ROUTING_FILE || join(process.env.GATE_HOME || join(homedir(), ".gate"), "routing.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoutingConfig>;
      cached = {
        ...DEFAULT_CONFIG,
        ...parsed,
        tiers: { ...DEFAULT_CONFIG.tiers, ...parsed.tiers },
        aliases: { ...DEFAULT_CONFIG.aliases, ...parsed.aliases },
        thresholds: { ...DEFAULT_CONFIG.thresholds, ...parsed.thresholds },
        categories: { ...DEFAULT_CONFIG.categories, ...parsed.categories },
        effort: normalizeEffortMap({ ...DEFAULT_CONFIG.effort, ...parsed.effort }),
        classifier: { ...DEFAULT_CONFIG.classifier, ...parsed.classifier },
        sticky: { ...DEFAULT_CONFIG.sticky, ...parsed.sticky },
      };
      return cached;
    } catch {
      // fall through to defaults
    }
  }
  cached = DEFAULT_CONFIG;
  return cached;
}

/** Reset the in-process config cache (used after the UI writes routing.json). */
export function resetRoutingCache(): void {
  cached = null;
}

function normalizeEffortMap(m: Record<string, unknown>): Record<RouteCategory, RouteEffort> {
  const out = {} as Record<RouteCategory, RouteEffort>;
  for (const k of Object.keys(m) as RouteCategory[]) out[k] = normalizeEffort(m[k]);
  return out;
}

/** Rough token estimate: ~4 chars/token over the serialized prompt payload. */
function estimateTokens(body: Record<string, unknown>): number {
  let chars = 0;
  const sys = body.system;
  if (typeof sys === "string") chars += sys.length;
  else if (Array.isArray(sys)) chars += JSON.stringify(sys).length;
  const msgs = body.messages;
  if (Array.isArray(msgs)) chars += JSON.stringify(msgs).length;
  return Math.ceil(chars / 4);
}

function lastUserText(body: Record<string, unknown>): string {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Record<string, unknown>;
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
        .join(" ");
    }
  }
  return "";
}

function systemText(body: Record<string, unknown>): string {
  const sys = body.system;
  if (typeof sys === "string") return sys;
  if (Array.isArray(sys)) {
    return sys
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
      .join(" ");
  }
  return "";
}

export interface RouteResult {
  model: string;
  tier: Tier;
  reason: string;
  /** Difficulty category that drove the decision; null for explicit/alias routes. */
  category: RouteCategory | null;
  /** Estimated (or exact, when count_tokens is on) prompt tokens. */
  tokens: number;
}

export interface RouteOptions {
  /** Exact prompt token count (from count_tokens) to use instead of the estimate. */
  tokenOverride?: number;
}

function tierToModel(cfg: RoutingConfig, tier: Tier): string {
  return cfg.tiers[tier];
}

/**
 * Resolve the model to use for a request. `requested` is the `model` field from
 * the incoming payload (may be an alias, a tier name, or a concrete model).
 */
export function routeModel(
  requested: string | undefined,
  body: Record<string, unknown>,
  opts: RouteOptions = {},
): RouteResult {
  const cfg = loadRoutingConfig();
  const req = (requested || "").trim();
  const reqLower = req.toLowerCase();
  const tokens = opts.tokenOverride ?? estimateTokens(body);

  // 1. Explicit concrete Claude model → pass through unless configured otherwise.
  if (cfg.overrideExplicit && reqLower.startsWith("claude-")) {
    return { model: req, tier: inferTier(cfg, req), reason: "explicit model", category: null, tokens };
  }

  // 2. Alias mapping.
  const alias = cfg.aliases[reqLower];
  if (alias && alias !== "auto") {
    if (alias in cfg.tiers) {
      return { model: tierToModel(cfg, alias as any), tier: alias as any, reason: `alias:${reqLower}`, category: null, tokens };
    }
    if (alias.toLowerCase().startsWith("claude-")) {
      return { model: alias, tier: inferTier(cfg, alias), reason: `alias:${reqLower}`, category: null, tokens };
    }
  }

  // 3. Heuristic routing: classify the request into a difficulty category, then
  //    map that category to the tier the user configured for it.
  const text = lastUserText(body).toLowerCase();
  const sysText = systemText(body).toLowerCase();
  const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);

  const isBackground =
    (!hasTools && maxTokens > 0 && maxTokens < 50) ||
    cfg.backgroundKeywords.some((k) => sysText.includes(k) || text.includes(k));
  const heavy = cfg.heavyKeywords.some((k) => text.includes(k));

  let category: RouteCategory;
  let detail: string;
  if (isBackground) {
    category = "background";
    detail = "background/utility task";
  } else if (heavy) {
    category = "heavy";
    detail = "heavy-intent keyword";
  } else if (tokens >= cfg.thresholds.largeContext) {
    category = "largeContext";
    detail = `large context (~${tokens} tok)`;
  } else if (!hasTools && tokens <= cfg.thresholds.trivial) {
    category = "trivial";
    detail = `trivial (~${tokens} tok)`;
  } else if (hasTools) {
    category = "agentic";
    detail = "agentic (tools present)";
  } else {
    category = "default";
    detail = "default";
  }

  let tier = cfg.categories[category] ?? cfg.default;
  // Haiku's 200K window: never route an oversized prompt to it.
  if (tier === "haiku" && tokens > cfg.thresholds.haikuContextMax) {
    tier = "sonnet";
    detail += " (haiku window guard)";
  }
  return { model: tierToModel(cfg, tier), tier, reason: detail, category, tokens };
}

/** Next cheaper tier, used by the rate-limit throttle. */
export function cheaperTier(tier: Tier): Tier | null {
  const order: Tier[] = ["fable", "opus", "sonnet", "haiku"];
  const i = order.indexOf(tier);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}

function inferTier(cfg: RoutingConfig, model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}
