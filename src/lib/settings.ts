import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Central gate settings (compression, caching, budget, fallback, reasoning).
 * Persisted at ~/.gate/settings.json and editable from the dashboard.
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
    /** Default effort injected when the client doesn't specify one. */
    defaultEffort: "none" | "low" | "medium" | "high";
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
  reasoning: { defaultEffort: "none" },
};

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");
const FILE = join(GATE_DIR, "settings.json");

let cached: GateSettings | null = null;

export function loadSettings(): GateSettings {
  if (cached) return cached;
  if (existsSync(FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<GateSettings>;
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
  reasoning?: Partial<GateSettings["reasoning"]>;
}

export function saveSettings(patch: SettingsPatch): GateSettings {
  const merged = mergeSettings(loadSettings(), patch);
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = merged;
  return merged;
}

function mergeSettings(base: GateSettings, patch: SettingsPatch): GateSettings {
  return {
    compression: { ...base.compression, ...patch.compression },
    cache: { ...base.cache, ...patch.cache },
    budget: { ...base.budget, ...patch.budget },
    fallback: {
      enabled: patch.fallback?.enabled ?? base.fallback.enabled,
      chains: { ...base.fallback.chains, ...patch.fallback?.chains },
    },
    reasoning: { ...base.reasoning, ...patch.reasoning },
  };
}
