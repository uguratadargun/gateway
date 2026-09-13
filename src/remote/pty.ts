import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The one native piece a remote session needs: a pseudo-terminal.
 *
 * Claude Code's TUI will not draw into a pipe, and a person typing into it
 * needs a terminal on the other end, so the server holds a real pty per
 * session — the same node-pty the cockpit uses on the desktop. It is an
 * optional dependency, deliberately: everything else gate does needs no native
 * build (that is why storage is `node:sqlite`), and a gate that cannot build it
 * keeps working and says why remote sessions are off instead of failing to
 * install.
 *
 * Loaded through `createRequire` rather than an import, so the bundler never
 * tries to follow it and a missing module is a value here, not a build error.
 */

export interface PtyProcess {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], opts: PtySpawnOptions) => PtyProcess;

const g = globalThis as unknown as { __gateRemotePty?: { spawn: PtySpawn | null; reason: string | null } };

/**
 * node-pty's `spawn-helper` sometimes lands without its execute bit (npm does
 * not always keep a prebuild's mode), and then every spawn fails with
 * "posix_spawnp failed". Restored here, once, before the first spawn — the
 * install script the cockpit carries for this would have to be remembered on
 * every server, and this cannot be forgotten.
 */
function ensureHelperExecutable(root: string): void {
  if (process.platform === "win32") return;
  const dirs = [join(root, "build", "Release"), join(root, "build", "Debug")];
  for (const base of [join(root, "prebuilds"), join(root, "bin")]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) dirs.push(join(base, entry));
  }
  for (const dir of dirs) {
    const helper = join(dir, "spawn-helper");
    try {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode & 0o777;
      if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
    } catch {
      // Not ours to fix (a read-only install): the spawn will say so.
    }
  }
}

/** The pty factory, or why there is none. Resolved once per process. */
export function loadPty(): { spawn: PtySpawn | null; reason: string | null } {
  if (g.__gateRemotePty) return g.__gateRemotePty;
  let result: { spawn: PtySpawn | null; reason: string | null };
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    const main = req.resolve("node-pty");
    // lib/index.js → the package root, where the prebuilds sit.
    ensureHelperExecutable(join(main, "..", ".."));
    const mod = req("node-pty") as { spawn: PtySpawn };
    result = { spawn: (file, args, opts) => mod.spawn(file, args, opts), reason: null };
  } catch (e) {
    result = {
      spawn: null,
      reason: `node-pty is not installed on the gate server (${(e as Error).message.split("\n")[0]}) — run \`npm install\` there; it needs a C++ toolchain on Linux`,
    };
  }
  g.__gateRemotePty = result;
  return result;
}

/** Tests put a fake terminal in place of node-pty; `null` goes back to the real one. */
export function setPtyForTests(spawn: PtySpawn | null, reason: string | null = null): void {
  g.__gateRemotePty = spawn || reason ? { spawn, reason } : undefined;
}
