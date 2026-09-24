import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PLUGIN_MARKETPLACE } from "./protocol";

/**
 * Central gate settings. Persisted at ~/.gate/settings.json and editable from
 * the dashboard.
 */

export interface GateSettings {
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
  /**
   * The memory layer: a finished run is read by the recorder, which writes
   * the decisions it made — logic, not code — for the runs that come after.
   * `model` is what the recorder runs on: a `provider:<name>/<model>`, since
   * gate holds no Claude account. Empty until someone names one, and until
   * then finished runs wait in the ledger.
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
    /**
     * How often, in minutes, the record index reads every connected
     * repository's base branch — its design docs, decision records, specs and
     * the commits that name them — and checks recorded decisions against it.
     * Code, not a model: it costs a fetch. 0 leaves it to the button.
     */
    indexEveryMinutes: number;
    /**
     * Record merges on a base branch that no gate run made, the way a run is
     * recorded — one model call per merge. Off by default: the index already
     * reads those merges' documents for nothing, and a model call per merge is
     * a cost somebody should choose.
     */
    recordMerges: boolean;
  };
}

export const DEFAULT_SETTINGS: GateSettings = {
  plugin: { source: process.env.GATE_PLUGIN_SOURCE?.trim() || PLUGIN_MARKETPLACE },
  memory: { enabled: true, model: "", embeddings: { provider: "", model: "" }, consolidateEvery: 5, indexEveryMinutes: 15, recordMerges: false },
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

/**
 * Deep-partial patch: any section, any field within it, may be omitted. A
 * settings file written when gate still had a gateway carries sections for it
 * (cache, budget, routing, the account pool…); they are read past and dropped
 * on the next save.
 */
export interface SettingsPatch {
  plugin?: Partial<GateSettings["plugin"]>;
  memory?: Partial<Omit<GateSettings["memory"], "embeddings">> & { embeddings?: Partial<GateSettings["memory"]["embeddings"]> };
}

export function saveSettings(patch: SettingsPatch): GateSettings {
  const merged = mergeSettings(loadSettings(), patch);
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = merged;
  return merged;
}

function mergeSettings(base: GateSettings, patch: SettingsPatch): GateSettings {
  const model = patch.memory?.model == null ? base.memory.model : patch.memory.model.trim();
  return {
    // An emptied field falls back to the default rather than handing out
    // "/plugin marketplace add " with nothing after it.
    plugin: { source: patch.plugin?.source?.trim() || base.plugin.source },
    memory: {
      enabled: patch.memory?.enabled ?? base.memory.enabled,
      // Only a provider model can be served here; a Claude tier left from
      // before reads as "no model", which the recorder says out loud.
      model: /^(provider|local):/.test(model) ? model : "",
      embeddings: {
        provider: (patch.memory?.embeddings?.provider ?? base.memory.embeddings.provider).trim(),
        model: (patch.memory?.embeddings?.model ?? base.memory.embeddings.model).trim(),
      },
      consolidateEvery: Math.max(0, Math.floor(patch.memory?.consolidateEvery ?? base.memory.consolidateEvery)),
      indexEveryMinutes: Math.max(0, Math.floor(patch.memory?.indexEveryMinutes ?? base.memory.indexEveryMinutes)),
      recordMerges: patch.memory?.recordMerges ?? base.memory.recordMerges,
    },
  };
}
