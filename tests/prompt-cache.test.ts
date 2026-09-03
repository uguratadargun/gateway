import { describe, expect, it } from "vitest";

import { applyPromptCaching } from "@/lib/prompt-cache";

describe("applyPromptCaching", () => {
  it("marks the end of system, tools, and the last message", () => {
    const body: Record<string, unknown> = {
      system: "You are terse.",
      tools: [{ name: "a" }, { name: "b" }],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: "again" },
      ],
    };
    const r = applyPromptCaching(body, "5m");
    expect(r.breakpoints).toBe(3);
    expect((body.system as any[])[0]).toEqual({ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } });
    expect((body.tools as any[])[1].cache_control).toEqual({ type: "ephemeral" });
    expect((body.tools as any[])[0].cache_control).toBeUndefined();
    const last = (body.messages as any[])[2];
    expect(last.content).toEqual([{ type: "text", text: "again", cache_control: { type: "ephemeral" } }]);
    // earlier messages untouched
    expect((body.messages as any[])[1].content[0].cache_control).toBeUndefined();
  });

  it("propagates the 1h ttl", () => {
    const body: Record<string, unknown> = { system: "s", messages: [{ role: "user", content: "x" }] };
    applyPromptCaching(body, "1h");
    expect((body.system as any[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("never overrides client-placed breakpoints", () => {
    const body: Record<string, unknown> = {
      system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "r" },
      ],
    };
    const r = applyPromptCaching(body);
    expect(r.breakpoints).toBe(0);
    expect((body.system as any[])[1].cache_control).toBeUndefined();
    expect(typeof (body.messages as any[])[1].content).toBe("string");
  });

  it("is a no-op on an empty request", () => {
    const body: Record<string, unknown> = { messages: [] };
    expect(applyPromptCaching(body).applied).toBe(false);
  });
});

describe("client-managed caching (Claude Code)", () => {
  it("adds nothing when the client caches any section — no mixed TTLs", () => {
    const body: Record<string, unknown> = {
      tools: [{ name: "Bash" }, { name: "Read" }],
      system: [
        { type: "text", text: "billing" },
        { type: "text", text: "sentinel" },
        { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const r = applyPromptCaching(body, "5m");
    expect(r.breakpoints).toBe(0);
    expect((body.tools as any[]).every((t) => !t.cache_control)).toBe(true);
    expect(typeof (body.messages as any[])[0].content).toBe("string");
  });
});
