import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resetRoutingCache, routeModel } from "@/lib/router";

const user = (content: string) => [{ role: "user", content }];

describe("routeModel", () => {
  it("passes an explicit claude-* model through untouched", () => {
    const r = routeModel("claude-opus-5", { messages: user("hi") });
    expect(r.model).toBe("claude-opus-5");
    expect(r.tier).toBe("opus");
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

  it("routes background/utility traffic (title generation) to the cheap tier", () => {
    const r = routeModel("auto", { messages: user("Generate a title for this conversation") });
    expect(r.tier).toBe("haiku");
    expect(r.reason).toContain("background");
  });

  it("treats tiny max_tokens without tools as background", () => {
    const r = routeModel("auto", { max_tokens: 20, messages: user("summarise the plan in depth please") });
    expect(r.tier).toBe("haiku");
    expect(r.reason).toContain("background");
  });

  it("routes short, tool-less prompts to the trivial tier", () => {
    const r = routeModel("auto", { messages: user("hi") });
    expect(r.tier).toBe("haiku");
    expect(r.reason).toContain("trivial");
  });

  it("routes tool-using requests to the agentic tier", () => {
    const r = routeModel("auto", {
      system: "helper",
      tools: [{ name: "t" }],
      messages: user("please do the thing"),
    });
    expect(r.tier).toBe("sonnet");
    expect(r.reason).toContain("agentic");
  });

  it("escalates heavy-intent keywords to the top tier", () => {
    const r = routeModel("auto", { messages: user("think hard about this architecture") });
    expect(r.tier).toBe("fable");
    expect(r.model).toBe("claude-fable-5-1");
  });

  it("keeps very large contexts on the 1M-window daily driver (Sonnet)", () => {
    const r = routeModel("auto", { messages: user("x".repeat(800_000)) });
    expect(r.tier).toBe("sonnet");
    expect(r.reason).toContain("large context");
  });

  it("ignores background keywords buried in a long agent system prompt", () => {
    const longSystem = "You are an agent. When asked, summarize this conversation. " + "Rules. ".repeat(600);
    const r = routeModel("auto", { system: longSystem, tools: [{ name: "Bash" }], messages: user("fix the failing build") });
    expect(r.tier).toBe("sonnet");
    expect(r.reason).toContain("agentic");
    const short = routeModel("auto", { system: "Summarize this conversation in one line.", messages: user("...") });
    expect(short.tier).toBe("haiku");
  });

  it("background beats heavy-intent when both match", () => {
    const r = routeModel("auto", { messages: user("generate a title, think hard") });
    expect(r.tier).toBe("haiku");
  });

  it("falls back to the default tier for mid-size prompts", () => {
    const r = routeModel("auto", { messages: user("word ".repeat(1200)) });
    expect(r.tier).toBe("sonnet");
    expect(r.reason).toBe("default");
  });
});

describe("overrideExplicit", () => {
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

  it("false sends a named claude model through the heuristics", () => {
    withConfig({ overrideExplicit: false, tiers: { sonnet: "provider:zai/glm-4.6" } });
    const r = routeModel("claude-sonnet-5[1m]", { tools: [{ name: "Bash" }], messages: user("fix the build") });
    expect(r.model).toBe("provider:zai/glm-4.6");
    expect(r.category).toBe("agentic");
  });

  it("false still lets an alias name a provider model outright", () => {
    withConfig({ overrideExplicit: false, aliases: { "claude-sonnet-5": "provider:zai/glm-4.6" } });
    const r = routeModel("claude-sonnet-5", { messages: user("hi") });
    expect(r.model).toBe("provider:zai/glm-4.6");
    expect(r.reason).toBe("alias:claude-sonnet-5");
  });

  it("true leaves the same request on the model it named", () => {
    withConfig({ overrideExplicit: true, tiers: { sonnet: "provider:zai/glm-4.6" } });
    const r = routeModel("claude-sonnet-5[1m]", { tools: [{ name: "Bash" }], messages: user("fix the build") });
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.reason).toBe("explicit model");
  });
});
