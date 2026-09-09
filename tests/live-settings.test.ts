import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyGatewaySettings, gatewayEnv, isOnGateway } from "@/client/live";

/**
 * `gate live` edits Claude Code's own settings so a session starts on the
 * gateway with nothing typed. It has to leave everything else in that file
 * alone, both ways.
 */
describe("putting Claude Code on the gateway through its settings", () => {
  it("adds the gateway to env, keeps the rest, and takes exactly that out again", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-live-"));
    const path = join(dir, ".claude", "settings.local.json");
    const env = gatewayEnv("http://gate.test/api/gateway", "k1");

    expect(applyGatewaySettings(path, env, true)).toBe(true);
    let settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://gate.test/api/gateway");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("k1");
    // And the prompt-bar notice about connectors is silenced with it.
    expect(settings.disableClaudeAiConnectors).toBe(true);
    expect(isOnGateway(path, "http://gate.test/api/gateway")).toBe(true);
    expect(isOnGateway(path, "http://other/api/gateway")).toBe(false);
    // Already there: nothing to write.
    expect(applyGatewaySettings(path, env, true)).toBe(false);

    // Somebody's own settings around it survive a second apply and the removal.
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { ...settings.env, MY_VAR: "x" } }));
    expect(applyGatewaySettings(path, gatewayEnv("http://gate.test/api/gateway", "k2"), true)).toBe(true);
    settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("k2");
    expect(settings.env.MY_VAR).toBe("x");
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);

    expect(applyGatewaySettings(path, env, false)).toBe(true);
    settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.env).toEqual({ MY_VAR: "x" });
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect("disableClaudeAiConnectors" in settings).toBe(false);
    expect(isOnGateway(path, "http://gate.test/api/gateway")).toBe(false);

    // With nothing else in env, the key goes away entirely.
    writeFileSync(path, JSON.stringify({ env: env, disableClaudeAiConnectors: true }));
    applyGatewaySettings(path, env, false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("refuses to guess at a settings file that is not an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-live-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "[1]");
    expect(() => applyGatewaySettings(path, gatewayEnv("u", "k"), true)).toThrow("not a JSON object");
  });
});
