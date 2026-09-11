import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readConfig, writeConfig } from "@/client/config";

/**
 * The CLI's saved login, and the environment that may stand in for it for
 * one command without replacing it.
 */

const previous = { GATE_HOME: process.env.GATE_HOME, GATE_URL: process.env.GATE_URL, GATE_KEY: process.env.GATE_KEY };

afterEach(() => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the CLI's connection", () => {
  it("comes from the environment when both halves are set, and says so", () => {
    process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-cfg-"));
    writeConfig({ url: "http://company:4141", key: "gate_company", team: "desktop" });
    process.env.GATE_URL = "http://127.0.0.1:4141/";
    process.env.GATE_KEY = "gate_local";
    expect(readConfig()).toEqual({ url: "http://127.0.0.1:4141", key: "gate_local", fromEnv: true });
    // The file is what it was: the environment stood in, it did not move in.
    delete process.env.GATE_URL;
    delete process.env.GATE_KEY;
    expect(readConfig()).toMatchObject({ url: "http://company:4141", key: "gate_company", team: "desktop" });
    expect(readConfig()?.fromEnv).toBeUndefined();
    expect(readFileSync(join(process.env.GATE_HOME!, "client.json"), "utf8")).not.toContain("gate_local");
  });
});
