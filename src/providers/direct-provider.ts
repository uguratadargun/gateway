import { sendToProvider } from "@/lib/provider-exec";
import { getProviderByName, parseProviderRef } from "@/lib/providers";
import { WorkflowError } from "@/runtime/errors";

import { fromAnthropicMessage, toAnthropicBody, type AnthropicMessage } from "./anthropic-shape";

import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from "./types";

/**
 * The server's own way to a model: one configured provider, called directly.
 *
 * gate holds no Claude account, so the few model calls the server still makes
 * itself — the memory recorder and consolidation, which read a finished run
 * and write what it decided — go to an endpoint named under Providers: a vLLM
 * or Ollama on the gate's own machine, or a hosted one. `model` is a
 * `provider:<name>/<model>` reference and nothing else; a Claude alias names
 * something the server has no way to reach, and is refused with the setting
 * that would fix it.
 *
 * A transient failure — a 5xx, an overloaded endpoint, a connection that did
 * not open — is tried again twice with a short backoff; anything else is the
 * answer.
 */
export class ProviderModelProvider implements ModelProvider {
  async execute(req: ModelProviderRequest): Promise<ModelProviderResult> {
    const ref = parseProviderRef(req.model);
    if (!ref) {
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `"${req.model}" is not a provider model — the server holds no Claude account, so its own model calls go to a provider: set a provider:<name>/<model> in Settings`,
        { model: req.model },
      );
    }
    const provider = getProviderByName(ref.provider);
    if (!provider || !provider.enabled) {
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `provider "${ref.provider}" is ${provider ? "disabled" : "not configured"} — add it under Providers`,
        { model: req.model },
      );
    }

    const body = toAnthropicBody(req) as Record<string, unknown>;
    let res: Response | null = null;
    let failure = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      try {
        res = await sendToProvider({ provider, ref, body: structuredClone(body), stream: false, signal: req.signal });
        if (!retryable(res.status)) break;
        failure = `${res.status}`;
      } catch (e) {
        if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
        res = null;
        failure = (e as Error).message;
      }
      if (attempt < MAX_RETRIES) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
    if (!res) {
      throw new WorkflowError("MODEL_EXECUTION_ERROR", `cannot reach provider "${ref.provider}": ${failure}`, { model: req.model });
    }

    const raw = await res.text();
    if (!res.ok) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
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
    // Named as it was asked for: the endpoint's own name for the model says
    // nothing about which provider served it.
    return fromAnthropicMessage(json, req.model, req.model);
  }
}

const MAX_RETRIES = 2;

function retryable(status: number): boolean {
  return status >= 500 || status === 529;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
