import type {
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  TextBlock,
  ToolUseBlock,
} from "@/providers/types";

/**
 * Deterministic stand-in for a real model. `handler` returns the text (or a
 * full result) for each call, so engine tests can script an agent's answers —
 * including "fails first, passes on the retry", and tool calls followed by a
 * final answer — without any network.
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
    const text = partial.text ?? "";
    const toolUses = partial.toolUses ?? [];
    const content: Array<TextBlock | ToolUseBlock> =
      partial.content ?? [...(text ? [{ type: "text", text } as TextBlock] : []), ...toolUses];
    return {
      text,
      content,
      toolUses,
      stopReason: partial.stopReason ?? (toolUses.length ? "tool_use" : "end_turn"),
      model: partial.model ?? req.model,
      usage: partial.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  /** Calls made for a given workflow node, in order. */
  callsFor(nodeId: string): ModelProviderRequest[] {
    return this.calls.filter((c) => c.context?.nodeId === nodeId);
  }
}

/** Convenience for scripting a tool call in a test handler. */
export function toolUse(name: string, input: unknown, id = `tu_${name}`): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}
