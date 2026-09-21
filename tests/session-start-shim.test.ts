import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The SessionStart hook puts `gate` on the machine.
 *
 * This is the whole of connecting without Claude Code: a person whose weekly
 * limit is spent cannot run `/gate:login`, because a slash command is a prompt
 * and a prompt is a model turn. The shim is therefore written ahead of time, by
 * every ordinary session, so a terminal is always a way in.
 */

const HOOK = fileURLToPath(new URL("../plugins/gate/scripts/session-start.mjs", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../plugins/gate/scripts/gate.mjs", import.meta.url));

function runHook(home: string): void {
  // No CLAUDE_ENV_FILE: an old Claude Code, which still gets the shim.
  execFileSync(process.execPath, [HOOK], {
    env: { ...process.env, HOME: home, CLAUDE_ENV_FILE: undefined },
    stdio: "ignore",
  });
}

describe("the SessionStart hook's gate shim", () => {
  it("writes an executable ~/.local/bin/gate pointing at the bundle beside it", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    runHook(home);
    const shim = join(home, ".local", "bin", "gate");
    expect(readFileSync(shim, "utf8")).toBe(`#!/bin/sh\nexec node "${BUNDLE}" "$@"\n`);
    // Executable by its owner, or it is not a command.
    expect(statSync(shim).mode & 0o700).toBe(0o700);
  });

  it("leaves an up-to-date shim alone, and rewrites one pointing somewhere else", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    runHook(home);
    const shim = join(home, ".local", "bin", "gate");

    // A second session must not rewrite the file: the steady state is a read.
    const old = new Date(Date.now() - 60_000);
    utimesSync(shim, old, old);
    runHook(home);
    expect(statSync(shim).mtimeMs).toBe(old.getTime());

    // A plugin update moves the bundle, and the shim follows it.
    execFileSync("/bin/sh", ["-c", `printf '#!/bin/sh\\nexec node "/old/gate.mjs" "$@"\\n' > ${shim}`]);
    runHook(home);
    expect(readFileSync(shim, "utf8")).toContain(BUNDLE);
  });
});
