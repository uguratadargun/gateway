#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SessionStart hook. Three jobs, all of them things only a hook can do.
 *
 * **It puts `gate` on the PATH.** Everything written down for a person to type
 * assumes a `gate` that exists, and the moment they may need it most is one
 * where no prompt runs. The shim is written ahead of that, by every ordinary
 * session. `cmdInstall` in `src/client/cli.ts` writes the same shim by hand;
 * the two must agree on its contents.
 *
 * **It takes gate's old gateway wiring out of Claude Code's settings.** Before
 * 0.47 logging in put every session on the gate's gateway, with a gate key as
 * its credential. The gate serves no models any more, so a session still
 * wired that way reaches nothing; this removes exactly what gate wrote, from
 * the user's settings and this directory's, and says so. `withoutGatewayWiring`
 * in `src/client/claude-settings.ts` does the same for `gate login` and
 * `gate reset`; the two must agree on what counts as gate's.
 *
 * **It tells the `gate` CLI which Claude Code session it runs in.** The CLI
 * cannot see that id from a Bash tool call, but this hook can: Claude Code
 * hands it the session on stdin and, where it supports it, a file whose
 * exports become the session's environment. One line there, and every
 * `gate begin` in this session names the session driving the run.
 *
 * Silent when nothing applies: a `~/.local/bin` that cannot be written is a
 * machine without a shim, a settings file that is not JSON is left alone, and
 * an old Claude Code with no env file is a session whose runs do not name it.
 * None is a reason to fail a session start.
 */
installShim();
cleanGatewayWiring();

/**
 * Writes `~/.local/bin/gate`, pointing at the bundle shipped beside this hook.
 *
 * Only when it would change: the steady state is one read per session, and a
 * plugin update — a new versioned bundle path — rewrites it on the next one,
 * so the shim always runs the plugin Claude Code actually loaded.
 */
function installShim() {
  try {
    const bundle = fileURLToPath(new URL("./gate.mjs", import.meta.url));
    const target = join(homedir(), ".local", "bin");
    const shim = join(target, "gate");
    const contents = `#!/bin/sh\nexec node "${bundle}" "$@"\n`;
    let current = "";
    try {
      current = readFileSync(shim, "utf8");
    } catch {
      // No shim yet, or one this process may not read: write it.
    }
    if (current === contents) return;
    mkdirSync(target, { recursive: true });
    writeFileSync(shim, contents, { mode: 0o755 });
  } catch {
    // A machine whose ~/.local/bin cannot be written has no shim, and that is
    // all: the plugin's own commands invoke the bundle by absolute path.
  }
}

/**
 * Removes gate's gateway wiring from the user's settings and this directory's:
 * a base URL ending in the gateway's path, a credential that is a gate key,
 * the two variables and the setting only the gateway wanted, and the provider
 * rows in the model picker. What it removed is printed, which Claude Code
 * shows the session; the change reaches the next session started.
 */
function cleanGatewayWiring() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const changed = [];
  for (const path of [join(configDir, "settings.json"), join(process.cwd(), ".claude", "settings.local.json")]) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      if (!text.trim()) continue;
      const settings = JSON.parse(text);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      if (!withoutGatewayWiring(settings)) continue;
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      changed.push(path);
    } catch {
      // Not JSON, or not writable: left as it is.
    }
  }
  if (changed.length) {
    console.log(
      `gate took its old gateway settings out of ${changed.join(" and ")}: Claude Code now runs on your own Claude ` +
        "login. Restart Claude Code once, and run `claude /login` if it asks you to sign in.",
    );
  }
}

function withoutGatewayWiring(settings) {
  const before = JSON.stringify(settings);
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? { ...settings.env } : null;
  if (env && typeof env.ANTHROPIC_BASE_URL === "string" && /\/api\/gateway\/?$/.test(env.ANTHROPIC_BASE_URL.trim())) {
    delete env.ANTHROPIC_BASE_URL;
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      if (typeof env[k] === "string" && /^gate_/.test(env[k])) delete env[k];
    }
    for (const k of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]) delete env[k];
    if (Object.keys(env).length) settings.env = env;
    else delete settings.env;
    delete settings.disableClaudeAiConnectors;
  }
  const picker = settings.modelPicker;
  if (picker && typeof picker === "object" && !Array.isArray(picker) && Array.isArray(picker.options)) {
    const foreign = picker.options.filter((row) => {
      const model = row?.model;
      return !(typeof model === "string" && (model.startsWith("provider:") || model.startsWith("local:")));
    });
    if (foreign.length) settings.modelPicker = { ...picker, options: foreign };
    else delete settings.modelPicker;
  }
  return JSON.stringify(settings) !== before;
}

const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let id = "";
  try {
    id = String(JSON.parse(raw).session_id ?? "");
  } catch {
    // Not the hook's JSON; nothing to record.
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) process.exit(0);
  try {
    appendFileSync(envFile, `export GATE_CLAUDE_SESSION=${id}\n`);
  } catch {
    // An env file that cannot be written is a session its runs do not name.
  }
});
