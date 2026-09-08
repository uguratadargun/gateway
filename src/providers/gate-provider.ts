import { executeMessages } from "@/lib/gateway-core";
import { WorkflowError } from "@/runtime/errors";

import { fromAnthropicMessage, toAnthropicBody, type AnthropicMessage } from "./anthropic-shape";

import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from "./types";

/**
 * Runs agent calls through gate's own proxy pipeline — routing, adaptive
 * reasoning, prompt caching, budget, concurrency, retry/fallback and traffic
 * logging all apply exactly as they do for an external client. It is an
 * in-process call into `executeMessages`, not an HTTP round trip back to
 * ourselves.
 */
export class GateModelProvider implements ModelProvider {
  async execute(req: ModelProviderRequest): Promise<ModelProviderResult> {
    const body = toAnthropicBody(req);

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
      // Stopping a run aborts the upstream fetch, and the pipeline turns that
      // into a 502 response rather than a rejection — so the abort arrives
      // here, not in the catch above. Without this check a run the user
      // stopped is recorded as a model failure.
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

    return fromAnthropicMessage(json, req.model, res.headers.get("x-gate-model"));
  }
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
