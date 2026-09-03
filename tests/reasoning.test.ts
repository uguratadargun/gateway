import { describe, expect, it } from "vitest";

import { applyReasoning, effortSupported, normalizeEffort, sanitizeForModel, thinkingModeFor } from "@/lib/reasoning";

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

describe("sanitizeForModel (client params → target model)", () => {
  it("strips effort and adaptive thinking when the router lands on Haiku", () => {
    const body: Record<string, unknown> = { output_config: { effort: "medium" }, thinking: { type: "adaptive" }, max_tokens: 1 };
    sanitizeForModel(body, "claude-haiku-4-5-20251001");
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("keeps other output_config keys on Haiku", () => {
    const body: Record<string, unknown> = { output_config: { effort: "low", format: { type: "json_schema" } } };
    sanitizeForModel(body, "claude-haiku-4-5-20251001");
    expect(body.output_config).toEqual({ format: { type: "json_schema" } });
  });

  it("converts thinking.enabled budgets to adaptive + effort on Claude 5", () => {
    const body: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 10000 } };
    sanitizeForModel(body, "claude-sonnet-5");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("drops thinking.disabled where the model rejects it", () => {
    const fable: Record<string, unknown> = { thinking: { type: "disabled" } };
    sanitizeForModel(fable, "claude-fable-5-1");
    expect(fable.thinking).toBeUndefined();
    const opusMax: Record<string, unknown> = { thinking: { type: "disabled" }, output_config: { effort: "max" } };
    sanitizeForModel(opusMax, "claude-opus-5");
    expect(opusMax.thinking).toBeUndefined();
    const opusHigh: Record<string, unknown> = { thinking: { type: "disabled" } };
    sanitizeForModel(opusHigh, "claude-opus-5");
    expect(opusHigh.thinking).toEqual({ type: "disabled" });
  });

  it("leaves a well-formed adaptive request untouched", () => {
    const body: Record<string, unknown> = { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
    sanitizeForModel(body, "claude-opus-5");
    expect(body).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });
});

describe("mid-conversation system messages", () => {
  it("folds them into the next user turn on Haiku and drops effort-only markers", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "system", content: [{ type: "text", text: "reminder: be terse" }] },
        { role: "user", content: "second" },
      ],
    };
    sanitizeForModel(body, "claude-haiku-4-5-20251001");
    const msgs = body.messages as any[];
    expect(msgs.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2].content).toEqual([{ type: "text", text: "reminder: be terse" }, { type: "text", text: "second" }]);
  });

  it("keeps the role on adaptive models but strips per-message effort where unsupported", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "system", content: [{ type: "text", text: "note" }], output_config: { effort: "low" } },
        { role: "user", content: "c" },
      ],
    };
    sanitizeForModel(structuredClone(body), "claude-opus-5");
    const sonnet = structuredClone(body);
    sanitizeForModel(sonnet, "claude-sonnet-5");
    const sys = (sonnet.messages as any[]).find((x) => x.role === "system");
    expect(sys.output_config).toBeUndefined();
    expect(sys.content[0].text).toBe("note");
    const opus = structuredClone(body);
    sanitizeForModel(opus, "claude-opus-5");
    expect((opus.messages as any[]).find((x) => x.role === "system").output_config).toEqual({ effort: "low" });
  });

  it("turns a trailing system message into a user turn on Haiku", () => {
    const body: Record<string, unknown> = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "system", content: "wrap up" }] };
    sanitizeForModel(body, "claude-haiku-4-5-20251001");
    expect((body.messages as any[]).at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "wrap up" }] });
  });
});

describe("context_management vs thinking", () => {
  it("drops clear_thinking edits when thinking is gone on Haiku", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015" }, { type: "clear_tool_uses_20250919" }] },
    };
    sanitizeForModel(body, "claude-haiku-4-5-20251001");
    expect(body.thinking).toBeUndefined();
    expect(body.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
    const only: Record<string, unknown> = { context_management: { edits: [{ type: "clear_thinking_20251015" }] } };
    sanitizeForModel(only, "claude-haiku-4-5-20251001");
    expect(only.context_management).toBeUndefined();
  });

  it("keeps clear_thinking on adaptive models with thinking on", () => {
    const body: Record<string, unknown> = { thinking: { type: "adaptive" }, context_management: { edits: [{ type: "clear_thinking_20251015" }] } };
    sanitizeForModel(body, "claude-sonnet-5");
    expect(body.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015" }] });
  });
});
