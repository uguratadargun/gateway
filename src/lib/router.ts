import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalModelRef, parseProviderRef } from "./providers";

/**
 * Model name resolution.
 *
 * gate resolves the name a client asked for into a concrete endpoint — a
 * provider reference, a concrete `claude-*` id, or a tier alias. It does not
 * infer which model *should* answer: the caller declares that, and the caller
 * knows better. A name that resolves to nothing is an error, not an invitation
 * to guess. See docs/decisions/0015.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export interface RoutingConfig {
  /** Concrete model ids for each tier. */
  tiers: Record<Tier, string>;
  /** Alias → concrete model (or tier name). Case-insensitive keys. */
  aliases: Record<string, string>;
  /**
   * Which tier an unrecognised provider model counts as. It decides nothing
   * about which model answers — only which fallback chain applies when the
   * model is in no tier slot at all.
   */
  default: Tier;
}

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
  },
  default: "sonnet",
};

let cached: RoutingConfig | null = null;

export function loadRoutingConfig(): RoutingConfig {
  if (cached) return cached;
  const file = process.env.GATE_ROUTING_FILE || join(process.env.GATE_HOME || join(homedir(), ".gate"), "routing.json");
  if (existsSync(file)) {
    try {
      // A file written before 0.39 carries keys that no longer exist
      // (categories, thresholds, presets). Reading only what we still use
      // leaves them in place and inert rather than failing the load.
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoutingConfig>;
      cached = {
        ...DEFAULT_CONFIG,
        tiers: { ...DEFAULT_CONFIG.tiers, ...parsed.tiers },
        aliases: { ...DEFAULT_CONFIG.aliases, ...parsed.aliases },
        default: parsed.default ?? DEFAULT_CONFIG.default,
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

/**
 * A model name gate cannot resolve. Carried to the caller as a 400: guessing
 * would put a conversation on a model nobody chose.
 */
export class UnresolvedModelError extends Error {
  constructor(readonly requested: string) {
    super(
      `gate cannot resolve the model "${requested}". Name a concrete model ` +
        `(claude-opus-5), a tier alias (haiku, sonnet, opus, fable), or a ` +
        `provider model (provider:<name>/<model>). ` +
        `If your client is still configured with "auto", re-run /gate:login to ` +
        `clear it, or pick a model with /model — gate no longer chooses one for you.`,
    );
    this.name = "UnresolvedModelError";
  }
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

export interface RouteResult {
  model: string;
  tier: Tier;
  reason: string;
  /** Estimated (or exact, when count_tokens is on) prompt tokens. Reported only. */
  tokens: number;
}

export interface RouteOptions {
  /** Exact prompt token count (from count_tokens) to use instead of the estimate. */
  tokenOverride?: number;
}

function tierToModel(cfg: RoutingConfig, tier: Tier): string {
  // Canonicalised on the way out, so a routing.json still holding the old
  // `local:` prefix produces the same model id the pickers now write.
  return canonicalModelRef(cfg.tiers[tier]);
}

/**
 * Resolve the model to use for a request. `requested` is the `model` field from
 * the incoming payload: a provider reference, a concrete `claude-*` id, or an
 * alias. Anything else throws {@link UnresolvedModelError}.
 */
export function routeModel(
  requested: string | undefined,
  body: Record<string, unknown>,
  opts: RouteOptions = {},
): RouteResult {
  const cfg = loadRoutingConfig();
  // Claude Code may append "[1m]" to mark a 1M window; it is not part of the id.
  const req = (requested || "").trim().replace(/\[1m\]$/i, "");
  const reqLower = req.toLowerCase();
  const tokens = opts.tokenOverride ?? estimateTokens(body);

  // 1. An explicit provider reference always wins: the caller named a specific
  //    endpoint, and there is no ladder to second-guess it with.
  if (parseProviderRef(req)) {
    return {
      model: canonicalModelRef(req),
      tier: inferTier(cfg, req),
      reason: "explicit provider model",
      tokens,
    };
  }

  // 2. A concrete Claude model passes through untouched. Prompt caches are
  //    per-model with no escape hatch, so swapping one under a live
  //    conversation costs more than it saves.
  if (reqLower.startsWith("claude-")) {
    return { model: req, tier: inferTier(cfg, req), reason: "explicit model", tokens };
  }

  // 3. Alias mapping — a name table, not a judgement.
  const alias = cfg.aliases[reqLower];
  if (alias) {
    if (alias in cfg.tiers) {
      return { model: tierToModel(cfg, alias as Tier), tier: alias as Tier, reason: `alias:${reqLower}`, tokens };
    }
    if (alias.toLowerCase().startsWith("claude-") || parseProviderRef(alias)) {
      return {
        model: canonicalModelRef(alias),
        tier: inferTier(cfg, alias),
        reason: `alias:${reqLower}`,
        tokens,
      };
    }
  }

  throw new UnresolvedModelError(req || "(none)");
}

function inferTier(cfg: RoutingConfig, model: string): Tier {
  // A provider model carries no Claude family name. Its tier is whichever slot
  // the user configured it into (that is what the fallback chain will use),
  // and the configured default when it is not in the ladder at all. Both sides
  // are canonicalised so a `local:`-era tier still matches a `provider:` ref.
  if (parseProviderRef(model)) {
    const ref = canonicalModelRef(model);
    const slot = (Object.keys(cfg.tiers) as Tier[]).find((t) => canonicalModelRef(cfg.tiers[t]) === ref);
    return slot ?? cfg.default;
  }
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}
