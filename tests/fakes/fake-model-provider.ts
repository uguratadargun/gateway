import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from "@/providers/types";

/**
 * Deterministic stand-in for a real model. `handler` returns the text (or a
 * full result) for each call, so memory tests can script the recorder's and
 * the consolidator's answers — including "fails first, passes on the retry" —
 * without any network.
 */
export class FakeModelProvider implements ModelProvider {
  readonly calls: ModelProviderRequest[] = [];

  constructor(
    private readonly handler: (
      req: ModelProviderRequest,
      callIndex: number,
    ) => string | Partial<ModelProviderResult> | Promise<string | Partial<ModelProviderResult>>,
  ) {}

  async execute(req: ModelProviderRequest): Promise<ModelProviderResult> {
    const index = this.calls.length;
    this.calls.push(req);
    const out = await this.handler(req, index);
    const partial = typeof out === "string" ? { text: out } : out;
    return {
      text: partial.text ?? "",
      stopReason: partial.stopReason ?? "end_turn",
      model: partial.model ?? req.model,
      usage: partial.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  /** Calls made by a given caller (`context.nodeId`), in order. */
  callsFor(nodeId: string): ModelProviderRequest[] {
    return this.calls.filter((c) => c.context?.nodeId === nodeId);
  }
}
