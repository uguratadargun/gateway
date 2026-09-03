import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
      snippet: `# one-off\nANTHROPIC_BASE_URL=${anthropicBase} ANTHROPIC_MODEL=auto ANTHROPIC_SMALL_FAST_MODEL=haiku claude\n\n# persistent (~/.claude/settings.json) — "auto" lets gate route by difficulty;\n# a concrete model id would bypass routing.\n{ "env": {\n  "ANTHROPIC_BASE_URL": "${anthropicBase}",\n  "ANTHROPIC_MODEL": "auto",\n  "ANTHROPIC_SMALL_FAST_MODEL": "haiku",\n  "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"\n} }`,
    },
    {
      id: "cursor",
      name: "Cursor",
      installed: existsSync(cursorDir),
      configPath: null,
      configured: false,
      canApply: false,
      snippet: `Cursor → Settings → Models → OpenAI API Key:\n  Override OpenAI Base URL: ${openaiBase}\n  API key: <a gate key, or any text if none issued>\nThen add model names: auto, haiku, sonnet, opus, fable`,
    },
    {
      id: "cline",
      name: "Cline",
      installed: existsSync(clineDir),
      configPath: null,
      configured: false,
      canApply: false,
      snippet: `Cline → API Provider: Anthropic\n  Use custom base URL: ${anthropicBase}\n  API key: <gate key or any text>\n  Model: auto (or haiku/sonnet/opus/fable)`,
    },
    {
      id: "opencode",
      name: "OpenCode",
      installed: existsSync(opencodeCfg) || existsSync(join(HOME, ".config", "opencode")),
      configPath: opencodeCfg,
      configured: false,
      canApply: false,
      snippet: `// ${opencodeCfg}\n{\n  "provider": {\n    "gate": {\n      "npm": "@ai-sdk/anthropic",\n      "options": { "baseURL": "${anthropicBase}", "apiKey": "gate" },\n      "models": { "auto": {}, "sonnet": {}, "opus": {}, "fable": {} }\n    }\n  }\n}`,
    },
    {
      id: "codex",
      name: "Codex CLI",
      installed: existsSync(codexCfg) || existsSync(join(HOME, ".codex")),
      configPath: codexCfg,
      configured: false,
      canApply: false,
      snippet: `# ${codexCfg}\nmodel_provider = "gate"\nmodel = "auto"\n\n[model_providers.gate]\nname = "gate"\nbase_url = "${openaiBase}"\nwire_api = "responses"\nenv_key = "GATE_API_KEY"   # export GATE_API_KEY=<gate key or any text>`,
    },
  ];
}

export function applyClaudeCode(baseUrl: string, apiKey?: string): { ok: true; backup: string | null } {
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
  // Claude Code always sends a concrete model id, which gate passes through
  // untouched; "auto" is what makes its traffic go through difficulty routing.
  env.ANTHROPIC_MODEL = "auto";
  env.ANTHROPIC_SMALL_FAST_MODEL = "haiku";
  // "auto" is not in Claude Code's model catalog; without this it assumes a
  // 200K window for auto-compact. Sonnet/Opus/Fable all have 1M.
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1000000";
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  cfg.env = env;
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
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === "1000000") delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (Object.keys(env).length) cfg.env = env;
  else delete cfg.env;
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { ok: true, backup };
}
