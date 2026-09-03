import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Central gate settings. Persisted at ~/.gate/settings.json and editable from
 * the dashboard.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export interface GateSettings {
  compression: {
    enabled: boolean;
    /** Truncate any single text/tool_result block longer than this many chars. */
    maxBlockChars: number;
    /** Drop exact-duplicate adjacent message blocks. */
    dedupe: boolean;
  };
  cache: {
    enabled: boolean;
    ttlSeconds: number;
  };
  budget: {
    enabled: boolean;
    /** "warn" adds a header; "block" returns 402 once exceeded. */
    mode: "warn" | "block";
    dailyUsd: number;
    monthlyUsd: number;
  };
  fallback: {
    enabled: boolean;
    /** Per-tier ordered fallback tiers, tried on 429/529. */
    chains: Record<Tier, Tier[]>;
  };
  reasoning: {
    /** Effort used when neither the request nor the routed category sets one ("default" = API default, high). */
    defaultEffort: "default" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  /** Anthropic prompt caching: auto-place cache_control breakpoints. */
  promptCache: {
    enabled: boolean;
    ttl: "5m" | "1h";
  };
  /** Bound simultaneous upstream requests; excess waits in a queue. */
  concurrency: {
    maxInFlight: number;
    queueTimeoutMs: number;
  };
  /** Soft protection as the 5h rate-limit window fills (utilization 0..1). */
  throttle: {
    enabled: boolean;
    /** At/above this utilization, route one tier cheaper. */
    downgradeAt: number;
    /** At/above this utilization, refuse with 429 until reset. */
    blockAt: number;
  };
  /** Transient-error retries (network/5xx/529) and short 429 waits. */
  retry: {
    maxRetries: number;
    maxRateLimitWaitMs: number;
  };
  /** Use Anthropic's count_tokens for exact routing thresholds (extra call). */
  routingPrecision: {
    countTokens: boolean;
  };
}

export const DEFAULT_SETTINGS: GateSettings = {
  compression: { enabled: false, maxBlockChars: 20_000, dedupe: true },
  // Off by default: a cached reply is a stale reply for chat. When enabled, only
  // deterministic requests (temperature unset or 0) are cached — see gateway-core.
  cache: { enabled: false, ttlSeconds: 3600 },
  budget: { enabled: false, mode: "warn", dailyUsd: 10, monthlyUsd: 200 },
  fallback: {
    enabled: true,
    chains: {
      fable: ["opus", "sonnet", "haiku"],
      opus: ["sonnet", "haiku"],
      sonnet: ["haiku"],
      haiku: [],
    },
  },
  reasoning: { defaultEffort: "default" },
  // 5m per Anthropic's guidance: active sessions refresh it for free, while a
  // 1h TTL doubles the cost of every cache write (2× vs 1.25×).
  promptCache: { enabled: true, ttl: "5m" },
  concurrency: { maxInFlight: 4, queueTimeoutMs: 60_000 },
  throttle: { enabled: true, downgradeAt: 0.85, blockAt: 0.98 },
  retry: { maxRetries: 2, maxRateLimitWaitMs: 5_000 },
  routingPrecision: { countTokens: false },
};

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");
const FILE = join(GATE_DIR, "settings.json");

let cached: GateSettings | null = null;

export function loadSettings(): GateSettings {
  if (cached) return cached;
  if (existsSync(FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(FILE, "utf8")) as SettingsPatch;
      cached = mergeSettings(DEFAULT_SETTINGS, parsed);
      return cached;
    } catch {
      // fall through to defaults
    }
  }
  cached = DEFAULT_SETTINGS;
  return cached;
}

/** Deep-partial patch: any section, any field within it, may be omitted. */
export interface SettingsPatch {
  compression?: Partial<GateSettings["compression"]>;
  cache?: Partial<GateSettings["cache"]>;
  budget?: Partial<GateSettings["budget"]>;
  fallback?: { enabled?: boolean; chains?: Partial<Record<Tier, Tier[]>> };
  /** "none" is the pre-v2 spelling of "default" and is normalized on merge. */
  reasoning?: { defaultEffort?: GateSettings["reasoning"]["defaultEffort"] | "none" };
  promptCache?: Partial<GateSettings["promptCache"]>;
  concurrency?: Partial<GateSettings["concurrency"]>;
  throttle?: Partial<GateSettings["throttle"]>;
  retry?: Partial<GateSettings["retry"]>;
  routingPrecision?: Partial<GateSettings["routingPrecision"]>;
}

export function saveSettings(patch: SettingsPatch): GateSettings {
  const merged = mergeSettings(loadSettings(), patch);
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = merged;
  return merged;
}

function mergeSettings(base: GateSettings, patch: SettingsPatch): GateSettings {
  // pre-v2 configs stored "none"; it meant "leave the API default".
  const rawEffort = patch.reasoning?.defaultEffort;
  const defaultEffort: GateSettings["reasoning"]["defaultEffort"] =
    rawEffort == null ? base.reasoning.defaultEffort : rawEffort === "none" ? "default" : rawEffort;
  return {
    compression: { ...base.compression, ...patch.compression },
    cache: { ...base.cache, ...patch.cache },
    budget: { ...base.budget, ...patch.budget },
    fallback: {
      enabled: patch.fallback?.enabled ?? base.fallback.enabled,
      chains: { ...base.fallback.chains, ...patch.fallback?.chains },
    },
    reasoning: { defaultEffort },
    promptCache: { ...base.promptCache, ...patch.promptCache },
    concurrency: { ...base.concurrency, ...patch.concurrency },
    throttle: { ...base.throttle, ...patch.throttle },
    retry: { ...base.retry, ...patch.retry },
    routingPrecision: { ...base.routingPrecision, ...patch.routingPrecision },
  };
}
