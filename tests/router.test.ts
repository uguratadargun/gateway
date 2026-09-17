import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resetRoutingCache, routeModel, UnresolvedModelError } from "@/lib/router";

const user = (content: string) => [{ role: "user", content }];

describe("routeModel", () => {
  it("passes an explicit claude-* model through untouched", () => {
    const r = routeModel("claude-opus-5", { messages: user("hi") });
    expect(r.model).toBe("claude-opus-5");
    expect(r.tier).toBe("opus");
    expect(r.reason).toBe("explicit model");
  });

  it("strips the [1m] window marker without otherwise touching the id", () => {
    const r = routeModel("claude-sonnet-5[1m]", { messages: user("hi") });
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.reason).toBe("explicit model");
  });

  it("maps OpenAI aliases onto tiers", () => {
    expect(routeModel("gpt-4o", { messages: user("a".repeat(5000)) }).tier).toBe("sonnet");
    expect(routeModel("gpt-4o-mini", { messages: user("x") }).tier).toBe("haiku");
    expect(routeModel("o3", { messages: user("x") }).tier).toBe("fable");
    expect(routeModel("o1", { messages: user("x") }).tier).toBe("opus");
  });

  it("maps bare tier names and 'fable'", () => {
    expect(routeModel("fable", { messages: user("x") }).model).toBe("claude-fable-5-1");
    expect(routeModel("haiku", { messages: user("x") }).tier).toBe("haiku");
  });

  it("resolves the same name the same way whatever the prompt looks like", () => {
    // The shape of a request decides nothing: a title job and a long agentic
    // turn on the same name land on the same model.
    const title = routeModel("sonnet", { max_tokens: 20, messages: user("Generate a title") });
    const agentic = routeModel("sonnet", {
      tools: [{ name: "Bash" }],
      messages: user("think hard about this " + "x".repeat(800_000)),
    });
    expect(title.model).toBe(agentic.model);
    expect(title.tier).toBe(agentic.tier);
  });

  it("refuses 'auto' and names the remedy", () => {
    expect(() => routeModel("auto", { messages: user("hi") })).toThrow(UnresolvedModelError);
    try {
      routeModel("auto", { messages: user("hi") });
    } catch (e) {
      expect((e as Error).message).toContain("/gate:login");
      expect((e as Error).message).toContain("/model");
    }
  });

  it("refuses a name it cannot resolve, and an absent one", () => {
    expect(() => routeModel("gpt-9-turbo", { messages: user("hi") })).toThrow(UnresolvedModelError);
    expect(() => routeModel(undefined, { messages: user("hi") })).toThrow(UnresolvedModelError);
  });
});

describe("routing.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-routing-"));
  const file = join(dir, "routing.json");
  const before = process.env.GATE_ROUTING_FILE;

  function withConfig(cfg: Record<string, unknown>) {
    writeFileSync(file, JSON.stringify(cfg));
    process.env.GATE_ROUTING_FILE = file;
    resetRoutingCache();
  }

  afterEach(() => {
    if (before === undefined) delete process.env.GATE_ROUTING_FILE;
    else process.env.GATE_ROUTING_FILE = before;
    resetRoutingCache();
  });

  it("lets an alias name a provider model outright", () => {
    withConfig({ aliases: { "claude-sonnet-5": "provider:zai/glm-4.6" } });
    const r = routeModel("claude-sonnet-5", { messages: user("hi") });
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.reason).toBe("explicit model");
    // The alias table is consulted only for names that are not concrete ids.
    expect(routeModel("sonnet", { messages: user("hi") }).tier).toBe("sonnet");
  });

  it("points a tier at a provider model", () => {
    withConfig({ tiers: { sonnet: "provider:zai/glm-4.6" } });
    const r = routeModel("sonnet", { messages: user("hi") });
    expect(r.model).toBe("provider:zai/glm-4.6");
    expect(r.tier).toBe("sonnet");
  });

  it("ignores pre-0.39 difficulty keys left in the file", () => {
    withConfig({
      preset: "quality",
      categories: { agentic: "opus" },
      classifier: { enabled: true },
      overrideExplicit: false,
      tiers: { sonnet: "claude-sonnet-5" },
    });
    const r = routeModel("claude-sonnet-5", { tools: [{ name: "Bash" }], messages: user("fix the build") });
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.reason).toBe("explicit model");
  });
});
