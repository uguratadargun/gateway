import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyGatewaySettings, applyPickerRows, gatewayEnv, isOnGateway } from "@/client/live";
import { pickerRow, PICKER_BEHAVES_AS } from "@/lib/model-picker";

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

  it("asks for gateway discovery and names no model at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-live-"));
    const path = join(dir, "settings.json");
    const env = gatewayEnv("http://gate.test/api/gateway", "k1");

    applyGatewaySettings(path, env, true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    // Which model answers is the person's, and Claude Code already names one
    // for every request it makes, background traffic included. Putting a model
    // in these settings would decide that for them.
    for (const key of Object.keys(settings.env)) expect(key).not.toMatch(/_MODEL$/);

    applyGatewaySettings(path, env, false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });
});

/**
 * The provider models are addressable without any of this — `/model
 * provider:zai/glm-5.3` always resolved — but nothing lists them, and Claude
 * Code's own gateway discovery drops every id that does not contain "claude"
 * or "anthropic". So gate writes the rows, and must leave any other row, and
 * the lineup's own flags, exactly as they were.
 */
describe("the provider models in Claude Code's /model picker", () => {
  const rows = [
    pickerRow({ id: "provider:zai/glm-5.3", display_name: "glm-5.3 (zai)", description: "zai · remote" }),
    pickerRow({ id: "provider:zai/glm-5.3-flash", display_name: "glm-5.3-flash (zai)", description: "zai · remote" }),
  ];

  it("builds a row Claude Code accepts, and falls back to the id for a name", () => {
    expect(rows[0]).toEqual({
      model: "provider:zai/glm-5.3",
      label: "glm-5.3 (zai)",
      description: "zai · remote",
      // Without this the client answers that the id "isn't described by this
      // version's model catalog" and the row does nothing.
      behavesAs: PICKER_BEHAVES_AS,
    });
    expect(pickerRow({ id: "provider:vllm/qwen3" }).label).toBe("provider:vllm/qwen3");
  });

  it("adds the rows, replaces them next time, and keeps everybody else's", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-picker-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        modelPicker: {
          replaceBuiltInOptions: false,
          options: [{ model: "claude-opus-4-8", label: "Opus 4.8" }, { model: "local:ollama/qwen2" }],
        },
        permissions: { allow: ["Bash(ls:*)"] },
      }),
    );

    expect(applyPickerRows(rows, true, path)).toBe(true);
    let settings = JSON.parse(readFileSync(path, "utf8"));
    // Somebody else's row stays, and stays first; the pre-0.30 `local:` row is
    // gate's own and is replaced rather than kept beside the new spelling.
    expect(settings.modelPicker.options.map((o: { model: string }) => o.model)).toEqual([
      "claude-opus-4-8",
      "provider:zai/glm-5.3",
      "provider:zai/glm-5.3-flash",
    ]);
    // A flag gate does not own is not gate's to rewrite.
    expect(settings.modelPicker.replaceBuiltInOptions).toBe(false);
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);

    // Same rows again: nothing to write.
    expect(applyPickerRows(rows, true, path)).toBe(false);

    // A provider that lost a model loses its row, without duplicating the rest.
    expect(applyPickerRows([rows[1]], true, path)).toBe(true);
    settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.modelPicker.options.map((o: { model: string }) => o.model)).toEqual([
      "claude-opus-4-8",
      "provider:zai/glm-5.3-flash",
    ]);

    expect(applyPickerRows([], false, path)).toBe(true);
    settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.modelPicker.options).toEqual([{ model: "claude-opus-4-8", label: "Opus 4.8" }]);
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
  });

  it("leaves no empty lineup behind when the rows were the whole of it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-picker-"));
    const path = join(dir, "settings.json");
    applyPickerRows(rows, true, path);
    expect(applyPickerRows([], false, path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    // Nothing there, nothing to remove.
    expect(applyPickerRows([], false, path)).toBe(false);
  });
});

describe("putting Claude Code on the gateway through its settings, continued", () => {
  it("refuses to guess at a settings file that is not an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-live-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "[1]");
    expect(() => applyGatewaySettings(path, gatewayEnv("u", "k"), true)).toThrow("not a JSON object");
  });
});
