import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeConfigDir } from "./subagents";

/**
 * Takes gate's old gateway wiring out of Claude Code's settings.
 *
 * Before 0.47 `gate login` put every Claude Code session of the person's on
 * the gate's gateway: an `env` block with the gateway as `ANTHROPIC_BASE_URL`
 * and the gate key as the credential, the claude.ai connectors switched off,
 * and provider models in the `/model` picker. The gate serves no models any
 * more, so a session still wired that way reaches nothing. This removes
 * exactly what gate wrote and leaves every other key as it was, so the
 * session is back on the person's own Claude login.
 *
 * Recognised by shape rather than by the key on disk: a base URL ending in
 * the gateway's path, a credential that is a gate key. The plugin's
 * SessionStart hook (`plugins/gate/scripts/session-start.mjs`) does the same
 * on every session start, and the two must agree on what counts as gate's.
 */

const GATEWAY_PATH = /\/api\/gateway\/?$/;
const GATE_KEY = /^gate_/;
const GATE_ONLY_ENV = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"];
const PICKER_PREFIXES = ["provider:", "local:"];

export function settingsPath(global: boolean, cwd = process.cwd()): string {
  return global ? join(claudeConfigDir(), "settings.json") : join(cwd, ".claude", "settings.local.json");
}

/** Removes gate's gateway wiring from one settings object. Mutates it; returns whether anything went. */
export function withoutGatewayWiring(settings: Record<string, unknown>): boolean {
  const before = JSON.stringify(settings);
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? { ...(settings.env as Record<string, unknown>) }
    : null;
  const base = env?.ANTHROPIC_BASE_URL;
  if (env && typeof base === "string" && GATEWAY_PATH.test(base.trim())) {
    delete env.ANTHROPIC_BASE_URL;
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      if (typeof env[k] === "string" && GATE_KEY.test(env[k] as string)) delete env[k];
    }
    for (const k of GATE_ONLY_ENV) delete env[k];
    if (Object.keys(env).length) settings.env = env;
    else delete settings.env;
    delete settings.disableClaudeAiConnectors;
  }
  const picker = settings.modelPicker;
  if (picker && typeof picker === "object" && !Array.isArray(picker)) {
    const p = picker as Record<string, unknown>;
    if (Array.isArray(p.options)) {
      const foreign = p.options.filter((row) => {
        const model = (row as { model?: unknown } | null)?.model;
        return !(typeof model === "string" && PICKER_PREFIXES.some((x) => model.startsWith(x)));
      });
      if (foreign.length) settings.modelPicker = { ...p, options: foreign };
      else delete settings.modelPicker;
    }
  }
  return JSON.stringify(settings) !== before;
}

/** Cleans one settings file. Returns whether it changed; a file that is not JSON is left alone. */
export function unsetGatewayWiring(path: string): boolean {
  if (!existsSync(path)) return false;
  let settings: unknown;
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return false;
    settings = JSON.parse(text);
  } catch {
    return false;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  if (!withoutGatewayWiring(settings as Record<string, unknown>)) return false;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** The user's settings and this directory's: what `gate login` and `gate reset` clean. Returns the lines to print. */
export function cleanGatewayWiring(cwd = process.cwd()): string[] {
  const lines: string[] = [];
  for (const global of [true, false]) {
    const path = settingsPath(global, cwd);
    try {
      if (unsetGatewayWiring(path)) lines.push(`took gate's old gateway settings out of ${path} — Claude Code runs on your own login`);
    } catch (e) {
      lines.push(`could not update ${path}: ${(e as Error).message}`);
    }
  }
  return lines;
}
