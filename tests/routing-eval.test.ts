import { describe, expect, it } from "vitest";

import { sessionFromRequest } from "@/lib/gateway-core";
import { gradeToRoute, loadRoutingConfig, PRESETS, routeModel, TIER_RANK } from "@/lib/router";
import { getSessionRoute, setSessionRoute } from "@/lib/usage";

const user = (content: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: "user", content }], ...extra });

/**
 * Labeled routing dataset — the regression guard for the heuristic layer.
 * Each case gives the maximum acceptable tier so tightening rules never
 * silently sends utility traffic to the top tier.
 */
const CASES: Array<{ name: string; body: Record<string, unknown>; maxTier: "haiku" | "sonnet" | "opus" | "fable"; minTier?: "haiku" | "sonnet" | "opus" | "fable" }> = [
  { name: "greeting", body: user("hi there"), maxTier: "haiku" },
  { name: "title generation", body: user("Generate a title for this conversation"), maxTier: "haiku" },
  { name: "tiny completion", body: user("Extract the city name from: 'Flights to Berlin are cheap'", { max_tokens: 20 }), maxTier: "haiku" },
  { name: "ordinary prompt mentioning architecture", body: user("explain the architecture step by step " + "context ".repeat(600)), maxTier: "sonnet" },
  { name: "agentic tool call", body: user("run the tests and fix failures", { system: "You are an agent", tools: [{ name: "bash" }] }), maxTier: "sonnet", minTier: "sonnet" },
  { name: "explicit heavy intent", body: user("think hard about the consistency model of this distributed cache"), maxTier: "fable", minTier: "fable" },
  { name: "large context stays on the 1M tier, not Opus", body: user("x".repeat(800_000)), maxTier: "sonnet", minTier: "sonnet" },
  { name: "haiku window guard", body: user("y".repeat(700_000), { max_tokens: 10 }), maxTier: "sonnet", minTier: "sonnet" },
];

describe("routing eval set (balanced preset)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = routeModel("auto", c.body);
      expect(TIER_RANK[r.tier]).toBeLessThanOrEqual(TIER_RANK[c.maxTier]);
      if (c.minTier) expect(TIER_RANK[r.tier]).toBeGreaterThanOrEqual(TIER_RANK[c.minTier]);
    });
  }

  it("defaults match the balanced preset and Anthropic's efficiency guidance", () => {
    const cfg = loadRoutingConfig();
    expect(cfg.categories).toEqual(PRESETS.balanced.categories);
    expect(cfg.effort).toEqual(PRESETS.balanced.effort);
    expect(cfg.categories.largeContext).toBe("sonnet");
    expect(cfg.effort.default).toBe("medium");
    expect(cfg.effort.background).toBe("low");
    expect(cfg.classifier.enabled).toBe(true);
    expect(cfg.sticky.enabled).toBe(true);
  });
});

describe("grade → route with the cost/quality dial", () => {
  it("maps grades and shifts by preset", () => {
    const cfg = loadRoutingConfig();
    expect(gradeToRoute(1, cfg)).toEqual({ tier: "haiku", effort: "low" });
    expect(gradeToRoute(3, cfg)).toEqual({ tier: "sonnet", effort: "medium" });
    expect(gradeToRoute(5, cfg)).toEqual({ tier: "fable", effort: "high" });
    expect(gradeToRoute(5, { ...cfg, preset: "economy" }).tier).toBe("opus");
    expect(gradeToRoute(3, { ...cfg, preset: "quality" }).tier).toBe("opus");
    expect(gradeToRoute(1, { ...cfg, preset: "economy" }).tier).toBe("haiku");
  });
});

describe("session identity vs sticky key", () => {
  it("a subagent (same session header, different system/tools) gets its own sticky baseline", () => {
    const h = new Headers({ "x-claude-code-session-id": "cc-session-1" });
    const parent = sessionFromRequest(h, { system: "You are the orchestrator", tools: [{ name: "Agent" }, { name: "Bash" }], messages: [{ role: "user", content: "refactor the auth module" }] });
    const sub = sessionFromRequest(h, { system: "You are an Explore subagent", tools: [{ name: "Read" }, { name: "Grep" }], messages: [{ role: "user", content: "find callers of login()" }] });
    const parentAgain = sessionFromRequest(h, { system: "You are the orchestrator", tools: [{ name: "Agent" }, { name: "Bash" }], messages: [{ role: "user", content: "refactor the auth module" }, { role: "assistant", content: "ok" }, { role: "user", content: "now tests" }] });
    expect(parent.id).toBe("cc-session-1");
    expect(sub.id).toBe("cc-session-1"); // same conversation for cost attribution
    expect(sub.stickyKey).not.toBe(parent.stickyKey); // but its own routing baseline
    expect(parentAgain.stickyKey).toBe(parent.stickyKey); // stable across turns
  });

  it("falls back to a prompt fingerprint without a session header", () => {
    const s = sessionFromRequest(new Headers(), { system: "sys", messages: [{ role: "user", content: "hello" }] });
    expect(s.id).toHaveLength(16);
    expect(s.stickyKey).toContain(":");
    expect(sessionFromRequest(new Headers(), { messages: [] }).id).toBeNull();
  });
});

describe("sticky session store", () => {
  it("persists and updates the session baseline", () => {
    expect(getSessionRoute("sess-x")).toBeNull();
    setSessionRoute("sess-x", "sonnet", "medium");
    expect(getSessionRoute("sess-x")).toEqual({ tier: "sonnet", effort: "medium" });
    setSessionRoute("sess-x", "opus", "high");
    expect(getSessionRoute("sess-x")).toEqual({ tier: "opus", effort: "high" });
  });
});
