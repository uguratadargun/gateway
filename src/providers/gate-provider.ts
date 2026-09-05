import { executeMessages } from "@/lib/gateway-core";
import { WorkflowError } from "@/runtime/errors";

import type {
  ModelProvider,
  ModelProviderMessage,
  ModelProviderRequest,
  ModelProviderResult,
  TextBlock,
  ToolUseBlock,
} from "./types";

/**
 * Runs agent calls through gate's own proxy pipeline — routing, adaptive
 * reasoning, prompt caching, budget, concurrency, retry/fallback and traffic
 * logging all apply exactly as they do for an external client. It is an
 * in-process call into `executeMessages`, not an HTTP round trip back to
 * ourselves.
 */
export class GateModelProvider implements ModelProvider {
  async execute(req: ModelProviderRequest): Promise<ModelProviderResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      messages: req.messages.map(toAnthropicMessage),
    };
    if (req.system) body.system = req.system;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }

    if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");

    const executionId = req.context?.executionId ?? null;
    const res = await executeMessages(body, {
      stream: false,
      clientBeta: null,
      effortHeader: req.effort ?? null,
      session: {
        id: executionId ? `workflow:${executionId}` : null,
        title: req.context?.workflowId ? `workflow: ${req.context.workflowId}` : null,
        // Each node keeps its own routing baseline, so a node revisited in a
        // loop stays on the same model and reuses its prompt cache.
        stickyKey: executionId && req.context?.nodeId ? `workflow:${executionId}:${req.context.nodeId}` : null,
      },
      requestPreview: JSON.stringify(body),
      signal: req.signal,
    }).catch((e) => {
      // The abort surfaces here as a fetch rejection; name it for what it is,
      // so a cancelled node is not reported as a model failure.
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      throw e;
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new WorkflowError("MODEL_EXECUTION_ERROR", `model call failed (${res.status}): ${truncate(raw)}`, {
        status: res.status,
        model: req.model,
      });
    }

    let json: AnthropicMessage;
    try {
      json = JSON.parse(raw) as AnthropicMessage;
    } catch {
      throw new WorkflowError("MODEL_EXECUTION_ERROR", "model returned a non-JSON response");
    }

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
      model: res.headers.get("x-gate-model") || json.model || req.model,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
}

function toAnthropicMessage(m: ModelProviderMessage): { role: string; content: unknown } {
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

interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
