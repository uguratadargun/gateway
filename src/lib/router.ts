import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  };
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
  /** When false, an explicit concrete `claude-*` model is always passed through. */
  overrideExplicit: boolean;
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
  thresholds: { largeContext: 180_000, trivial: 900 },
  heavyKeywords: [
    "think hard",
    "think deeply",
    "ultrathink",
    "deep dive",
    "step by step",
    "prove",
    "architect",
    "refactor the entire",
  ],
  backgroundKeywords: [
    "generate a title",
    "conversation title",
    "one-line summary",
    "short summary",
    "summarize this",
    "suggest a name",
  ],
  default: "sonnet",
  // Best practice: cheapest model that does the job, escalating by difficulty.
  // haiku → sonnet → opus → fable. Heavy reasoning is where the top model
  // earns its cost; large context goes to Opus for its native 1M window.
  categories: {
    background: "haiku",
    trivial: "haiku",
    agentic: "sonnet",
    largeContext: "opus",
    heavy: "fable",
    default: "sonnet",
  },
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
): RouteResult {
  const cfg = loadRoutingConfig();
  const req = (requested || "").trim();
  const reqLower = req.toLowerCase();

  // 1. Explicit concrete Claude model → pass through unless configured otherwise.
  if (cfg.overrideExplicit && reqLower.startsWith("claude-")) {
    return { model: req, tier: inferTier(cfg, req), reason: "explicit model" };
  }

  // 2. Alias mapping.
  const alias = cfg.aliases[reqLower];
  if (alias && alias !== "auto") {
    if (alias in cfg.tiers) {
      return { model: tierToModel(cfg, alias as any), tier: alias as any, reason: `alias:${reqLower}` };
    }
    if (alias.toLowerCase().startsWith("claude-")) {
      return { model: alias, tier: inferTier(cfg, alias), reason: `alias:${reqLower}` };
    }
  }

  // 3. Heuristic routing: classify the request into a difficulty category, then
  //    map that category to the tier the user configured for it.
  const tokens = estimateTokens(body);
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

  const tier = cfg.categories[category] ?? cfg.default;
  return { model: tierToModel(cfg, tier), tier, reason: detail };
}

function inferTier(cfg: RoutingConfig, model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}
