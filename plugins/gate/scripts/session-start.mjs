#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SessionStart hook. Two jobs, both of them things only a hook can do.
 *
 * **It puts `gate` on the PATH.** Everything written down for a person to type
 * assumes a `gate` that exists, and the one moment they need it most is the
 * moment they cannot ask for it: a Claude Code at its weekly limit runs no
 * prompt, so `/gate:login` — a slash command, and therefore a model turn — is
 * out of reach exactly when a person is trying to get off the account that is
 * out of quota. The shim is written ahead of that, by every ordinary session,
 * so `~/.local/bin/gate login <token>` already works from a terminal by the
 * time anyone needs it. `cmdInstall` in `src/client/cli.ts` writes the same
 * shim by hand; the two must agree on its contents.
 *
 * **It tells the `gate` CLI which Claude Code session it runs in.** A run
 * /gate:run drives does some of its nodes in the session itself, and the
 * session's model calls reach the gateway under the session's own id — not
 * under the run's. The CLI cannot see that id from a Bash tool call, but this
 * hook can: Claude Code hands it the session on stdin and, where it supports
 * it, a file whose exports become the session's environment. One line there,
 * and every `gate begin` in this session names the session, so the server can
 * cost the nodes the session did against the run.
 *
 * Silent when nothing applies: a `~/.local/bin` that cannot be written is a
 * machine without a shim, and an old Claude Code with no env file, or stdin
 * that is not the hook's JSON, is a session whose runs are simply not costed.
 * Neither is a reason to fail a session start.
 */
installShim();

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
    // An env file that cannot be written is a session that is not costed.
  }
});
