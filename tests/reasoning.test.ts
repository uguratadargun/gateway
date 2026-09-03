import { describe, expect, it } from "vitest";

import { applyReasoning, effortSupported, normalizeEffort, thinkingModeFor } from "@/lib/reasoning";

describe("model capability detection", () => {
  it("classifies thinking modes per Anthropic's table", () => {
    expect(thinkingModeFor("claude-fable-5-1")).toBe("adaptive");
    expect(thinkingModeFor("claude-opus-5")).toBe("adaptive");
    expect(thinkingModeFor("claude-sonnet-5")).toBe("adaptive");
    expect(thinkingModeFor("claude-sonnet-4-6")).toBe("adaptive");
    expect(thinkingModeFor("claude-haiku-4-5-20251001")).toBe("extended");
    expect(thinkingModeFor("claude-sonnet-4-5-20250929")).toBe("extended");
    expect(effortSupported("claude-haiku-4-5-20251001")).toBe(false);
    expect(effortSupported("claude-sonnet-5")).toBe(true);
  });

  it("normalizes legacy 'none' to 'default'", () => {
    expect(normalizeEffort("none")).toBe("default");
    expect(normalizeEffort("xhigh")).toBe("xhigh");
    expect(normalizeEffort("bogus")).toBe("default");
  });
});

describe("applyReasoning", () => {
  it("sets output_config.effort on adaptive models and never a budget", () => {
    const body: Record<string, unknown> = { model: "claude-sonnet-5", max_tokens: 1000 };
    expect(applyReasoning(body, null, "low", "claude-sonnet-5")).toBe("low");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.thinking).toBeUndefined();
  });

  it("uses thinking budgets on extended-only models and never effort", () => {
    const body: Record<string, unknown> = { model: "claude-haiku-4-5-20251001", max_tokens: 1000, temperature: 0.3 };
    applyReasoning(body, null, "high", "claude-haiku-4-5-20251001");
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBe(8192 + 4096);
    expect(body.temperature).toBeUndefined();
  });

  it("low effort on Haiku means no thinking at all", () => {
    const body: Record<string, unknown> = { model: "claude-haiku-4-5-20251001", max_tokens: 100 };
    applyReasoning(body, null, "low", "claude-haiku-4-5-20251001");
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("'default' leaves the request untouched (API default is high)", () => {
    const body: Record<string, unknown> = { model: "claude-opus-5" };
    applyReasoning(body, null, "default", "claude-opus-5");
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("respects client-set effort or thinking (e.g. Claude Code)", () => {
    const body: Record<string, unknown> = { model: "claude-opus-5", output_config: { effort: "xhigh" } };
    applyReasoning(body, "low", "low", "claude-opus-5");
    expect(body.output_config).toEqual({ effort: "xhigh" });
    const body2: Record<string, unknown> = { model: "claude-haiku-4-5-20251001", thinking: { type: "enabled", budget_tokens: 1024 } };
    applyReasoning(body2, null, "high", "claude-haiku-4-5-20251001");
    expect(body2.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("downgrades xhigh on models without it and turns adaptive on for 4.6 at high", () => {
    const b1: Record<string, unknown> = {};
    applyReasoning(b1, null, "xhigh", "claude-sonnet-4-6");
    expect(b1.output_config).toEqual({ effort: "high" });
    expect(b1.thinking).toEqual({ type: "adaptive" });
    const b2: Record<string, unknown> = {};
    applyReasoning(b2, null, "medium", "claude-sonnet-4-6");
    expect(b2.thinking).toBeUndefined();
  });

  it("header beats category beats default", () => {
    const body: Record<string, unknown> = {};
    expect(applyReasoning(body, "max", "low", "claude-opus-5")).toBe("max");
    expect(body.output_config).toEqual({ effort: "max" });
  });

  it("raises a tiny max_tokens at high+ effort so thinking can't eat the answer", () => {
    const hi: Record<string, unknown> = { max_tokens: 120 };
    applyReasoning(hi, null, "high", "claude-fable-5-1");
    expect(hi.max_tokens).toBe(8192);
    const med: Record<string, unknown> = { max_tokens: 120 };
    applyReasoning(med, null, "medium", "claude-sonnet-5");
    expect(med.max_tokens).toBe(120);
    const big: Record<string, unknown> = { max_tokens: 32000 };
    applyReasoning(big, null, "max", "claude-opus-5");
    expect(big.max_tokens).toBe(32000);
  });
});
