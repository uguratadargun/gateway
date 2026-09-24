import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutGatewayWiring } from "@/client/claude-settings";

/**
 * The SessionStart hook puts `gate` on the machine, and takes gate's old
 * gateway wiring out of Claude Code's settings.
 *
 * The shim is written ahead of time, by every ordinary session, so a terminal
 * is always a way in. The wiring is what `gate login` wrote before the gate
 * stopped serving models: left in place, it points every session at a gateway
 * that is not there any more.
 */

const HOOK = fileURLToPath(new URL("../plugins/gate/scripts/session-start.mjs", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../plugins/gate/scripts/gate.mjs", import.meta.url));

function runHook(home: string, cwd = home): string {
  // No CLAUDE_ENV_FILE: an old Claude Code, which still gets the shim.
  return execFileSync(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: undefined, CLAUDE_ENV_FILE: undefined },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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
    // Rounded: utimes takes a float of seconds and the filesystem keeps
    // nanoseconds, so a whole-millisecond time comes back as x.999 on APFS.
    // What is under test is that the file was not rewritten, not that two
    // clocks agree to the nanosecond.
    expect(Math.round(statSync(shim).mtimeMs)).toBe(old.getTime());

    // A plugin update moves the bundle, and the shim follows it.
    execFileSync("/bin/sh", ["-c", `printf '#!/bin/sh\\nexec node "/old/gate.mjs" "$@"\\n' > ${shim}`]);
    runHook(home);
    expect(readFileSync(shim, "utf8")).toContain(BUNDLE);
  });
});

describe("the SessionStart hook and gate's old gateway wiring", () => {
  const WIRED = {
    env: {
      ANTHROPIC_BASE_URL: "https://gate.example/api/gateway",
      ANTHROPIC_AUTH_TOKEN: "gate_0123",
      ANTHROPIC_API_KEY: "gate_0123",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      MY_OWN: "kept",
    },
    disableClaudeAiConnectors: true,
    modelPicker: { options: [{ model: "provider:vllm/qwen", label: "Qwen" }, { model: "claude-opus-5-5", label: "mine" }] },
    theme: "dark",
  };

  it("takes out exactly what gate wrote, from the user's settings and this directory's, and says so", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    const project = mkdtempSync(join(tmpdir(), "gate-project-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(WIRED));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: WIRED.env }));

    const said = runHook(home, project);

    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({
      env: { MY_OWN: "kept" },
      modelPicker: { options: [{ model: "claude-opus-5-5", label: "mine" }] },
      theme: "dark",
    });
    expect(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"))).toEqual({ env: { MY_OWN: "kept" } });
    expect(said).toContain("your own Claude login");
  });

  it("agrees with what `gate login` and `gate reset` take out", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(WIRED));
    runHook(home);
    const cli = structuredClone(WIRED) as unknown as Record<string, unknown>;
    expect(withoutGatewayWiring(cli)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual(cli);
    // Clean already: nothing to do, and it says so.
    expect(withoutGatewayWiring(cli)).toBe(false);
  });

  it("leaves a base URL that is not gate's gateway, and a key that is not gate's, alone", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const theirs = { env: { ANTHROPIC_BASE_URL: "https://llm.corp.example/v1", ANTHROPIC_API_KEY: "sk-ant-xyz" } };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(theirs));
    expect(runHook(home)).toBe("");
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual(theirs);
  });
});
