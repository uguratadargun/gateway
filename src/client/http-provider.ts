import { fromAnthropicMessage, toAnthropicBody, type AnthropicMessage } from "@/providers/anthropic-shape";
import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from "@/providers/types";
import { WorkflowError } from "@/runtime/errors";

/**
 * The engine's way to a model when the engine is on someone's laptop.
 *
 * It is the same pipeline a server-side run uses — routing, effort, prompt
 * caching, the account pool, budget, throttling and traffic logging all happen
 * on the gate this points at — reached over HTTP with the person's own API key
 * instead of by an in-process call. That is what keeps a local run a metered
 * run: nothing here talks to Anthropic, and no Claude credentials live on the
 * developer's machine for this to work.
 *
 * The session headers match `GateModelProvider`'s exactly, so a node keeps its
 * routing baseline and its prompt cache across a loop.
 */
export class HttpGateProvider implements ModelProvider {
  constructor(
    private readonly gatewayUrl: string,
    private readonly apiKey: string,
  ) {}

  async execute(req: ModelProviderRequest): Promise<ModelProviderResult> {
    if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");

    const body = toAnthropicBody(req);
    const executionId = req.context?.executionId ?? null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (executionId) headers["x-gate-session"] = `workflow:${executionId}`;
    if (req.effort) headers["x-gate-effort"] = req.effort;

    let res: Response;
    try {
      res = await fetch(`${this.gatewayUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      throw new WorkflowError("MODEL_EXECUTION_ERROR", `cannot reach the gateway: ${(e as Error).message}`, {
        model: req.model,
      });
    }

    const raw = await res.text();
    if (!res.ok) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      // 401 here is not a model failure; it is the key, and saying so saves
      // reading a run's history to find out why every node died the same way.
      if (res.status === 401 || res.status === 403) {
        throw new WorkflowError("MODEL_EXECUTION_ERROR", "the gateway refused this API key — run `gate login` again", {
          status: res.status,
        });
      }
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
    return fromAnthropicMessage(json, req.model, res.headers.get("x-gate-model"));
  }
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
