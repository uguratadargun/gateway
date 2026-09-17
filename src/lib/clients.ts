import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { pickerRow, withPickerRows, withoutPickerRows } from "./model-picker";
import { providerCatalogue } from "./providers";

/**
 * Local AI-client integration: detect installed tools and (for Claude Code)
 * write the gateway base URL into its settings, with a timestamped backup.
 * Other clients get copy-paste snippets.
 */

export interface ClientInfo {
  id: "claude-code" | "cursor" | "cline" | "opencode" | "codex";
  name: string;
  installed: boolean;
  configPath: string | null;
  /** True when the client's config already points at this gateway. */
  configured: boolean;
  canApply: boolean;
  snippet: string;
}

const HOME = homedir();
const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectClients(baseUrl: string): ClientInfo[] {
  const anthropicBase = `${baseUrl}/api/gateway`;
  const openaiBase = `${baseUrl}/api/gateway/v1`;

  const claudeCfg = existsSync(CLAUDE_SETTINGS) ? readJson(CLAUDE_SETTINGS) : null;
  const claudeEnv = (claudeCfg?.env as Record<string, string> | undefined) ?? {};

  const cursorDir = join(HOME, "Library", "Application Support", "Cursor");
  const clineDir = join(HOME, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const opencodeCfg = join(HOME, ".config", "opencode", "opencode.json");
  const codexCfg = join(HOME, ".codex", "config.toml");

  return [
    {
      id: "claude-code",
      name: "Claude Code",
      installed: existsSync(join(HOME, ".claude")),
      configPath: CLAUDE_SETTINGS,
      configured: claudeEnv.ANTHROPIC_BASE_URL === anthropicBase,
      canApply: true,
      snippet: `# one-off\nANTHROPIC_BASE_URL=${anthropicBase} claude\n\n# persistent (~/.claude/settings.json) — pick your model with /model as usual;\n# gate serves the one you name.\n{ "env": {\n  "ANTHROPIC_BASE_URL": "${anthropicBase}"\n} }`,
    },
    {
      id: "cursor",
      name: "Cursor",
      installed: existsSync(cursorDir),
      configPath: null,
      configured: false,
      canApply: false,
      snippet: `Cursor → Settings → Models → OpenAI API Key:\n  Override OpenAI Base URL: ${openaiBase}\n  API key: <a gate key, or any text if none issued>\nThen add model names: haiku, sonnet, opus, fable`,
    },
    {
      id: "cline",
      name: "Cline",
      installed: existsSync(clineDir),
      configPath: null,
      configured: false,
      canApply: false,
      snippet: `Cline → API Provider: Anthropic\n  Use custom base URL: ${anthropicBase}\n  API key: <gate key or any text>\n  Model: haiku, sonnet, opus or fable`,
    },
    {
      id: "opencode",
      name: "OpenCode",
      installed: existsSync(opencodeCfg) || existsSync(join(HOME, ".config", "opencode")),
      configPath: opencodeCfg,
      configured: false,
      canApply: false,
      snippet: `// ${opencodeCfg}\n{\n  "provider": {\n    "gate": {\n      "npm": "@ai-sdk/anthropic",\n      "options": { "baseURL": "${anthropicBase}", "apiKey": "gate" },\n      "models": { "haiku": {}, "sonnet": {}, "opus": {}, "fable": {} }\n    }\n  }\n}`,
    },
    {
      id: "codex",
      name: "Codex CLI",
      installed: existsSync(codexCfg) || existsSync(join(HOME, ".codex")),
      configPath: codexCfg,
      configured: false,
      canApply: false,
      snippet: `# ${codexCfg}\nmodel_provider = "gate"\nmodel = "sonnet"\n\n[model_providers.gate]\nname = "gate"\nbase_url = "${openaiBase}"\nwire_api = "responses"\nenv_key = "GATE_API_KEY"   # export GATE_API_KEY=<gate key or any text>`,
    },
  ];
}

/**
 * The row Claude Code offered for gate's difficulty router until 0.39. It is
 * not one of ours by its model id, so the picker merge would keep it as
 * somebody else's row; it is dropped here by name instead.
 */
function dropLegacyAutoRow(cfg: Record<string, unknown>): void {
  const picker = cfg.modelPicker as Record<string, unknown> | undefined;
  if (!picker || !Array.isArray(picker.options)) return;
  const rest = (picker.options as Array<Record<string, unknown>>).filter((row) => row.model !== "auto");
  if (rest.length) cfg.modelPicker = { ...picker, options: rest };
  else delete cfg.modelPicker;
}

export async function applyClaudeCode(baseUrl: string, apiKey?: string): Promise<{ ok: true; backup: string | null }> {
  const anthropicBase = `${baseUrl}/api/gateway`;
  const dir = join(HOME, ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let cfg: Record<string, unknown> = {};
  let backup: string | null = null;
  if (existsSync(CLAUDE_SETTINGS)) {
    cfg = readJson(CLAUDE_SETTINGS) ?? {};
    backup = `${CLAUDE_SETTINGS}.bak-${Date.now()}`;
    copyFileSync(CLAUDE_SETTINGS, backup);
  }
  const env = { ...((cfg.env as Record<string, string> | undefined) ?? {}) };
  env.ANTHROPIC_BASE_URL = anthropicBase;
  // gate serves the model Claude Code names; it does not pick one. A machine
  // connected before 0.39 still carries the old "auto" wiring, which gate now
  // refuses — clear it here so re-connecting repairs it.
  if (env.ANTHROPIC_MODEL === "auto") delete env.ANTHROPIC_MODEL;
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === "1000000") delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  // Until 0.39 this said `ANTHROPIC_SMALL_FAST_MODEL=haiku`, which sent the
  // background traffic through gate's `tiers` table. The variable is
  // deprecated by the client, and nothing replaces it: Claude Code names a
  // model for that traffic by itself and gate serves the name, as it serves
  // any other. Sending it somewhere else is one line in the person's own
  // settings, and theirs to write.
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  // Claude Code reads `/v1/models` from the gateway at startup when this is
  // set, which is how the connected account's own models reach the picker. It
  // keeps only ids containing "claude" or "anthropic", so it never surfaces a
  // provider model — those are the rows written below.
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  cfg.env = env;
  dropLegacyAutoRow(cfg);
  withPickerRows(cfg, (await providerCatalogue()).map(pickerRow));
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { ok: true, backup };
}

export function revertClaudeCode(): { ok: true; backup: string | null } {
  if (!existsSync(CLAUDE_SETTINGS)) return { ok: true, backup: null };
  const cfg = readJson(CLAUDE_SETTINGS) ?? {};
  const backup = `${CLAUDE_SETTINGS}.bak-${Date.now()}`;
  copyFileSync(CLAUDE_SETTINGS, backup);
  const env = { ...((cfg.env as Record<string, string> | undefined) ?? {}) };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (env.ANTHROPIC_MODEL === "auto") delete env.ANTHROPIC_MODEL;
  if (env.ANTHROPIC_SMALL_FAST_MODEL === "haiku") delete env.ANTHROPIC_SMALL_FAST_MODEL;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === "1000000") delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (Object.keys(env).length) cfg.env = env;
  else delete cfg.env;
  dropLegacyAutoRow(cfg);
  withoutPickerRows(cfg);
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { ok: true, backup };
}
