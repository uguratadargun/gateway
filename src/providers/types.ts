import type { Effort } from "@/lib/reasoning";

/**
 * The runtime's only way to reach a model. Everything model-specific lives
 * behind this interface, so the engine never knows which provider — or which
 * vendor — actually serves a node, and tests can run the whole orchestrator
 * with no network at all.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

/** A model's request to run one tool. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** The answer handed back for one `tool_use`, on the next turn. */
export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ProviderContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ModelProviderMessage {
  role: "user" | "assistant";
  content: string | ProviderContentBlock[];
}

/** A tool as the model sees it: a name, a description and a JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelProviderRequest {
  /** Tier alias ("sonnet"), or a concrete model id. Resolved downstream. */
  model: string;
  system?: string;
  messages: ModelProviderMessage[];
  effort?: Effort;
  maxTokens?: number;
  /** Tools the model may call this turn. Omitted entirely when there are none. */
  tools?: ToolDefinition[];
  /** Attribution for cost/traffic reporting; ignored by providers that lack it. */
  context?: { executionId?: string; nodeId?: string; workflowId?: string };
  /** Cancels the call. Aborting really drops the upstream request, so a
   *  cancelled run stops paying for the answer it will never read. */
  signal?: AbortSignal;
}

export interface ModelProviderResult {
  text: string;
  /** The assistant turn verbatim, to be appended before any tool results. */
  content: Array<TextBlock | ToolUseBlock>;
  /** Tool calls the model wants run before it can answer. */
  toolUses: ToolUseBlock[];
  stopReason: string | null;
  /** The model that actually served the request (may differ after routing). */
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface ModelProvider {
  execute(req: ModelProviderRequest): Promise<ModelProviderResult>;
}
