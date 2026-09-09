import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { claudeConfigDir } from "./subagents";

/**
 * Puts Claude Code on the gateway by its own settings, so that starting it
 * needs nothing typed.
 *
 * Claude Code applies the `env` block of its settings to every session it
 * starts — and to every subprocess of that session, which is how `gate next`
 * later knows it is on the gateway. Written to the project's own
 * `.claude/settings.local.json` by default: that scopes the gateway to the
 * repository the person runs pipelines in, and Claude Code keeps that file
 * out of git. `--global` writes the user's `~/.claude/settings.json` instead.
 */

/** What a session needs to be on the gateway, keyed as Claude Code reads it. */
export function gatewayEnv(gatewayUrl: string, key: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    // The headless executor sets both; Claude Code takes either, and a
    // session where the two disagree is a session that authenticates as
    // somebody else.
    ANTHROPIC_API_KEY: key,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function settingsPath(global: boolean, cwd = process.cwd()): string {
  return global ? join(claudeConfigDir(), "settings.json") : join(cwd, ".claude", "settings.local.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merges the gateway variables into the settings file's `env`, leaving every
 * other key as it was; or, with `on` false, removes exactly those variables.
 * Returns whether the file changed.
 */
export function applyGatewaySettings(path: string, env: Record<string, string>, on: boolean): boolean {
  const settings = readSettings(path);
  const current = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  if (on) {
    for (const [k, v] of Object.entries(env)) next[k] = v;
  } else {
    for (const k of Object.keys(env)) delete next[k];
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) return false;
  if (Object.keys(next).length) settings.env = next;
  else delete settings.env;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** Whether the settings file already carries this gateway. */
export function isOnGateway(path: string, gatewayUrl: string): boolean {
  try {
    const env = readSettings(path).env as Record<string, unknown> | undefined;
    return typeof env?.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL === gatewayUrl;
  } catch {
    return false;
  }
}
