/**
 * The server's only way to reach a model: the memory recorder and
 * consolidation hand it one prompt and read one text answer. The interface
 * keeps them free of any endpoint's wire shape, and lets tests script the
 * answer with no network at all.
 */

export interface ModelProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelProviderRequest {
  /** A `provider:<name>/<model>` reference; `ProviderModelProvider` refuses anything else. */
  model: string;
  system?: string;
  messages: ModelProviderMessage[];
  maxTokens?: number;
  /** Which caller made the call. No provider reads it; tests pick calls out by `nodeId`. */
  context?: { executionId?: string; nodeId?: string; workflowId?: string };
  /** Cancels the call. Aborting really drops the upstream request, so a
   *  cancelled run stops paying for the answer it will never read. */
  signal?: AbortSignal;
}

export interface ModelProviderResult {
  text: string;
  stopReason: string | null;
  /** The model reference the call was made with. */
  model: string;
  /**
   * `inputTokens` is the whole prompt the model was shown, cache write
   * included; `cacheCreationTokens` is how much of it was written to the
   * prompt cache — a breakdown of `inputTokens`, not a figure to add to it.
   * It is kept because a cache write bills at 1.25× (5m) or 2× (1h) plain
   * input, so anything pricing a call needs the split.
   */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens?: number };
}

export interface ModelProvider {
  execute(req: ModelProviderRequest): Promise<ModelProviderResult>;
}
