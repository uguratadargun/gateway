import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMessages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gateway-core", () => ({ executeMessages }));

import { GateModelProvider } from "@/providers/gate-provider";
import { WorkflowError } from "@/runtime/errors";

function anthropicResponse(body: unknown, init: { status?: number; model?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.model ? { "x-gate-model": init.model } : {},
  });
}

describe("GateModelProvider", () => {
  beforeEach(() => executeMessages.mockReset());

  it("sends an Anthropic-shaped body through the existing proxy pipeline", async () => {
    executeMessages.mockResolvedValue(
      anthropicResponse(
        {
          model: "claude-sonnet-5",
          content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "  the answer  " }],
          usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100 },
        },
        { model: "claude-sonnet-5" },
      ),
    );

    const result = await new GateModelProvider().execute({
      model: "sonnet",
      system: "you are a tester",
      messages: [{ role: "user", content: "run it" }],
      effort: "low",
      context: { executionId: "exec1", nodeId: "tester", workflowId: "dev" },
    });

    expect(result).toMatchObject({
      text: "the answer",
      model: "claude-sonnet-5",
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 100 },
      toolUses: [],
    });

    const [body, opts] = executeMessages.mock.calls[0];
    expect(body).toMatchObject({ model: "sonnet", system: "you are a tester", messages: [{ role: "user", content: "run it" }] });
    expect(opts.stream).toBe(false);
    expect(opts.effortHeader).toBe("low");
    // Per-node sticky key: a node revisited in a loop keeps its model and cache.
    expect(opts.session.stickyKey).toBe("workflow:exec1:tester");
  });

  it("raises MODEL_EXECUTION_ERROR on an upstream failure", async () => {
    executeMessages.mockResolvedValue(new Response('{"error":"overloaded"}', { status: 529 }));
    await expect(
      new GateModelProvider().execute({ model: "sonnet", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "MODEL_EXECUTION_ERROR" });
  });

  it("raises MODEL_EXECUTION_ERROR when the response carries no text", async () => {
    executeMessages.mockResolvedValue(anthropicResponse({ content: [{ type: "thinking", thinking: "…" }] }));
    await expect(
      new GateModelProvider().execute({ model: "sonnet", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});
