import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { POOL_STRATEGIES, type PoolStrategy } from "./account-pool";
import { PLUGIN_MARKETPLACE } from "./protocol";

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
  /**
   * Where a machine that has never had the plugin fetches it from: what the
   * Team page tells people to `/plugin marketplace add`. The public repository
   * by default; a team that mirrors this repository on its own git host puts
   * that host's URL here, and the install lines the dashboard hands out name
   * it. `GATE_PLUGIN_SOURCE` in the environment sets the default.
   */
  plugin: {
    source: string;
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
  /**
   * The memory layer: a finished run is read by the recorder, which writes
   * the decisions it made — logic, not code — for the runs that come after.
   * `model` is what the recorder runs on; it reads a run's outputs and
   * writes a page, so a mid tier is enough.
   */
  memory: {
    enabled: boolean;
    model: string;
    /**
     * Semantic search, when a configured OpenAI-compatible provider serves an
     * embedding model: `provider` is the provider's name, `model` the model
     * to ask it for. Both empty means words alone (FTS5), which is the default.
     */
    embeddings: { provider: string; model: string };
    /**
     * After how many new decisions a team's implementation summary of a
     * feature is rewritten from all of them by the consolidation pass. 0 turns
     * the automatic pass off; the button on the feature stays.
     */
    consolidateEvery: number;
  };
  /** How a request picks among several connected Claude accounts. */
  accountPool: {
    strategy: PoolStrategy;
    /** round-robin only: requests one account serves in a row before rotating. */
    stickyRoundRobinLimit: number;
    /** Skip an account whose any quota window has this little left (0 = off). */
    quotaMinRemainingPercent: number;
    /**
     * How often the daemon polls Claude's usage endpoint per account. Only
     * idle accounts are polled at all — traffic refreshes the same windows for
     * free — and Anthropic rate-limits that endpoint separately, so this is
     * deliberately slow relative to a 5h window.
     */
    quotaRefreshMinutes: number;
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
  plugin: { source: process.env.GATE_PLUGIN_SOURCE?.trim() || PLUGIN_MARKETPLACE },
  concurrency: { maxInFlight: 4, queueTimeoutMs: 60_000 },
  throttle: { enabled: true, downgradeAt: 0.85, blockAt: 0.98 },
  retry: { maxRetries: 2, maxRateLimitWaitMs: 5_000 },
  routingPrecision: { countTokens: false },
  memory: { enabled: true, model: "sonnet", embeddings: { provider: "", model: "" }, consolidateEvery: 5 },
  // fill-first keeps one account warm — its prompt cache stays hot and the
  // others stay untouched until it runs out of window.
  accountPool: { strategy: "fill-first", stickyRoundRobinLimit: 3, quotaMinRemainingPercent: 0, quotaRefreshMinutes: 30 },
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
  plugin?: Partial<GateSettings["plugin"]>;
  concurrency?: Partial<GateSettings["concurrency"]>;
  throttle?: Partial<GateSettings["throttle"]>;
  retry?: Partial<GateSettings["retry"]>;
  routingPrecision?: Partial<GateSettings["routingPrecision"]>;
  memory?: Partial<Omit<GateSettings["memory"], "embeddings">> & { embeddings?: Partial<GateSettings["memory"]["embeddings"]> };
  accountPool?: Partial<GateSettings["accountPool"]>;
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
    // An emptied field falls back to the default rather than handing out
    // "/plugin marketplace add " with nothing after it.
    plugin: { source: patch.plugin?.source?.trim() || base.plugin.source },
    concurrency: { ...base.concurrency, ...patch.concurrency },
    throttle: { ...base.throttle, ...patch.throttle },
    retry: { ...base.retry, ...patch.retry },
    routingPrecision: { ...base.routingPrecision, ...patch.routingPrecision },
    memory: {
      enabled: patch.memory?.enabled ?? base.memory.enabled,
      model: patch.memory?.model?.trim() || base.memory.model,
      embeddings: {
        provider: (patch.memory?.embeddings?.provider ?? base.memory.embeddings.provider).trim(),
        model: (patch.memory?.embeddings?.model ?? base.memory.embeddings.model).trim(),
      },
      consolidateEvery: Math.max(0, Math.floor(patch.memory?.consolidateEvery ?? base.memory.consolidateEvery)),
    },
    accountPool: {
      ...base.accountPool,
      ...patch.accountPool,
      // A config written by an older gate — or hand-edited — must not put an
      // unknown strategy in front of the selector.
      strategy: POOL_STRATEGIES.includes(patch.accountPool?.strategy as PoolStrategy)
        ? (patch.accountPool!.strategy as PoolStrategy)
        : base.accountPool.strategy,
    },
  };
}
