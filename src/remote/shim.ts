import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The hook shim a remote session's Claude Code runs, and the settings file
 * that points its hooks at it.
 *
 * The same design the cockpit uses on a desktop (src/main/hookShim.ts there),
 * moved to the server: every hook reads its payload on stdin, tags it with the
 * terminal it came from, and forwards it over a unix socket to this process,
 * which answers most at once and holds two — the AskUserQuestion PreToolUse
 * and PermissionRequest — until the person answers from their cockpit. The
 * terminal never shows those prompts; the cockpit does. If gate is gone the
 * connect fails, the shim prints nothing, and the TUI asks as it always does.
 */

export const SHIM_FILE = "remote-hook.cjs";

/** How long a hook that is only a report waits for gate before letting the session go on (ms). */
export const SHIM_STATUS_TIMEOUT_MS = 5000;

/** Seconds Claude Code allows the two holding hooks: a day, effectively forever. */
export const BLOCKING_HOOK_TIMEOUT_S = 86400;

/** The status-only PreToolUse entry's argument, so an AskUserQuestion is held once, not twice. */
export const STATUS_ARG = "--status";

/** The environment the shim reads; set on every remote terminal. */
export const SHIM_ENV = {
  sock: "GATE_REMOTE_SOCK",
  terminal: "GATE_REMOTE_TERMINAL",
  token: "GATE_REMOTE_TOKEN",
} as const;

export const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
// gate remote-session hook shim — written by the gate server; edits are overwritten.
const net = require('net');
const isStatus = process.argv.includes('${STATUS_ARG}');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const sock = process.env.${SHIM_ENV.sock};
  if (!sock) process.exit(0);
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  if (isStatus) payload.hook_role = 'status';
  const event = payload.hook_event_name;
  const patient = !isStatus && (event === 'PermissionRequest' || (event === 'PreToolUse' && payload.tool_name === 'AskUserQuestion'));
  const frame = { v: 1, terminal: process.env.${SHIM_ENV.terminal} || null, token: process.env.${SHIM_ENV.token} || null, payload };
  let buf = '';
  let done = false;
  const finish = (line) => {
    if (done) return;
    done = true;
    if (line) process.stdout.write(line + '\\n');
    process.exit(0);
  };
  const c = net.createConnection(sock, () => { c.write(JSON.stringify(frame) + '\\n'); });
  c.setEncoding('utf8');
  c.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\\n');
    if (nl !== -1) finish(buf.slice(0, nl).trim());
  });
  c.on('end', () => finish(buf.trim()));
  c.on('close', () => finish(buf.trim()));
  c.on('error', () => finish(''));
  if (!patient) setTimeout(() => finish(''), ${SHIM_STATUS_TIMEOUT_MS}).unref();
});
`;

/** Writes the shim into `dir` when it differs, so a running hook never reads a half-written file. */
export function ensureShim(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SHIM_FILE);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current !== SHIM_SOURCE) writeFileSync(path, SHIM_SOURCE, { encoding: "utf8", mode: 0o644 });
  return path;
}

/** A POSIX double-quoted word: hook commands run through `sh -c`. */
function quote(s: string): string {
  return `"${s.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** The command a hook runs: this server's own node, which is certainly present, on the shim. */
export function hookCommand(shimPath: string, ...args: string[]): string {
  return [quote(process.execPath), quote(shimPath), ...args.map(quote)].join(" ");
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

export function sessionHooks(shimPath: string): Record<string, HookEntry[]> {
  const entry = (matcher?: string, timeout?: number, ...args: string[]): HookEntry => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: hookCommand(shimPath, ...args), ...(timeout ? { timeout } : {}) }],
  });
  return {
    SessionStart: [entry()],
    UserPromptSubmit: [entry()],
    PreToolUse: [entry("AskUserQuestion", BLOCKING_HOOK_TIMEOUT_S), entry("*", undefined, STATUS_ARG)],
    PostToolUse: [entry("*")],
    PermissionRequest: [entry("*", BLOCKING_HOOK_TIMEOUT_S)],
    Notification: [entry()],
    Stop: [entry()],
    SessionEnd: [entry()],
  };
}

/**
 * The settings file every remote terminal starts with. One file for all of
 * them: the terminal and its token travel in the environment, not in here.
 * `includeCoAuthoredBy: false` for the same reason the headless worker says
 * it — a commit a run makes is the team's.
 */
export function writeSessionSettings(dir: string, shimPath: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "remote-settings.json");
  const content = `${JSON.stringify({ includeCoAuthoredBy: false, hooks: sessionHooks(shimPath) }, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content, "utf8");
  return path;
}

/**
 * Where the hook socket lives. `sun_path` holds about 100 bytes and macOS
 * truncates a longer path silently, so a deep GATE_HOME gets a hashed name in
 * the temp dir instead of a socket beside its data.
 */
export function hookSocketPath(baseDir: string, platform: string = process.platform, tmp: string = tmpdir()): string {
  const hash = createHash("sha1").update(baseDir).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\gate-remote-${hash}`;
  const beside = `${baseDir.replace(/\/+$/, "")}/hooks.sock`;
  if (Buffer.byteLength(beside) <= 100) return beside;
  return `${tmp.replace(/\/+$/, "")}/gate-remote-${hash}.sock`;
}
