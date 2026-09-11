import { WorkflowError } from "@/runtime/errors";

import type {
  ModelProviderMessage,
  ModelProviderRequest,
  ModelProviderResult,
  TextBlock,
  ToolUseBlock,
} from "./types";

/**
 * The Anthropic Messages wire shape, on its own.
 *
 * Two providers speak it: the in-process one on the server, and the HTTP one
 * the client CLI uses to reach a gate across the network. Neither the request
 * body nor the reply differs between them — only how the call is made — so the
 * translation lives here rather than being written twice and drifting once.
 *
 * Nothing in this module may import the server: it is bundled into the CLI.
 */

export function toAnthropicMessage(m: ModelProviderMessage): { role: string; content: unknown } {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      if (b.type === "tool_result") {
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
      }
      return { type: "text", text: b.text };
    }),
  };
}

/** The request body for one node's turn. `model` may be a tier alias; gate routes it. */
export function toAnthropicBody(req: ModelProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages: req.messages.map(toAnthropicMessage),
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  return body;
}

export interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * A reply, in the terms the runtime uses. `routedModel` is what gate reported
 * serving it (the `x-gate-model` header), which may differ from what was asked
 * for — that is the whole point of routing.
 */
export function fromAnthropicMessage(
  json: AnthropicMessage,
  requestedModel: string,
  routedModel?: string | null,
): ModelProviderResult {
  const content: Array<TextBlock | ToolUseBlock> = [];
  for (const block of json.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  const toolUses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const text = content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // A turn that only calls tools carries no prose, and that is not an error.
  if (!text && !toolUses.length) throw new WorkflowError("MODEL_EXECUTION_ERROR", "model returned no content");

  return {
    text,
    content,
    toolUses,
    stopReason: json.stop_reason ?? null,
    model: routedModel || json.model || requestedModel,
    usage: {
      // Tokens written to the prompt cache were read by the model all the
      // same: with prompt caching on, the API reports a 20k-token prompt as
      // `input_tokens: 2` plus `cache_creation_input_tokens: 19998`, and a
      // node's usage used to show the 2. Counted as input here, and carried
      // apart as well, because a cache write does not bill at the input rate.
      inputTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: json.usage?.output_tokens ?? 0,
      cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
