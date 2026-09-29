import { WorkflowError } from "@/runtime/errors";

import type { ModelProviderRequest, ModelProviderResult } from "./types";

/**
 * The Anthropic Messages wire shape, on its own.
 *
 * The server's provider speaks it to whichever endpoint the recorder runs on;
 * the translation between gate's request type and that wire shape lives here.
 */

/** The request body for one call. `model` is the provider reference; the sender swaps in the endpoint's own id. */
export function toAnthropicBody(req: ModelProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system) body.system = req.system;
  return body;
}

export interface AnthropicMessage {
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * A reply, in the terms the recorder uses: its text blocks joined, named by
 * the `model` reference the call was made with — the endpoint's own name for
 * the model says nothing about which provider served it.
 */
export function fromAnthropicMessage(json: AnthropicMessage, model: string): ModelProviderResult {
  const text = (json.content ?? [])
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  if (!text) throw new WorkflowError("MODEL_EXECUTION_ERROR", "model returned no content");

  return {
    text,
    stopReason: json.stop_reason ?? null,
    model,
    usage: {
      // Tokens written to the prompt cache were read by the model all the
      // same: with prompt caching on, the API reports a 20k-token prompt as
      // `input_tokens: 2` plus `cache_creation_input_tokens: 19998`. Counted
      // as input here, and carried apart as well, because a cache write does
      // not bill at the input rate.
      inputTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: json.usage?.output_tokens ?? 0,
      cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
