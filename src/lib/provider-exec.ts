import { anthropicToOpenAIRequest, openAIStreamToAnthropic, openAIToAnthropicResponse } from "./anthropic-openai";
import { ANTHROPIC_VERSION } from "./claude/config";
import { formatProviderRef, providerApiKey, type Provider, type ProviderModelRef } from "./providers";

/**
 * Send one already-routed request to a configured provider and hand back an
 * Anthropic-shaped Response.
 *
 * That shape is the point: dispatch's usage parsing, the traffic log, the
 * response cache and every client downstream keep speaking Anthropic, so a
 * provider model is a routing decision rather than a second code path. How far
 * the body has to travel to get there depends on the dialect — a full
 * translation for `openai-compat`, a forward for `anthropic-compat`.
 */

const TIMEOUT_MS = 300_000;

function anthropicError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function sendToOpenAIProvider(opts: {
  provider: Provider;
  /** The upstream's own model id, without the `local:<provider>/` prefix. */
  model: string;
  /** Anthropic-dialect request body, as the router left it. */
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, model, body, stream } = opts;

  const upstreamBody = anthropicToOpenAIRequest(body, model);
  upstreamBody.stream = stream;
  if (stream) {
    // Without this, vLLM and friends omit usage from the stream entirely and
    // every streamed local request is accounted as zero tokens.
    upstreamBody.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  };
  const key = providerApiKey(provider.id);
  if (key) headers.Authorization = `Bearer ${key}`;

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return anthropicError(
      502,
      `Provider "${provider.label}" unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return anthropicError(res.status, text.slice(0, 2000) || `Provider returned ${res.status}`);
  }

  const modelRef = formatProviderRef(provider.name, model);

  if (!stream) {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return anthropicError(502, "Provider returned a non-JSON response");
    return new Response(JSON.stringify(openAIToAnthropicResponse(json, modelRef)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!res.body) return anthropicError(502, "Provider returned no stream");
  return new Response(openAIStreamToAnthropic(res.body, modelRef), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

// ── anthropic-compat: forward, do not translate ─────────────────────────────

/**
 * Fields only Anthropic's own models take. A third-party Anthropic-dialect
 * endpoint answers 400 on them, and they arrive constantly: Claude Code sends
 * `output_config.effort` and `thinking: adaptive` on every single request, and
 * gate's own router adds context-management edits. Dropping them is not a
 * downgrade — the target model has no such knob to begin with.
 *
 * What deliberately survives: `tools`, `tool_choice`, `system`, images, and
 * `cache_control` breakpoints. Those are ordinary Messages API, and Z.AI's
 * endpoint exists precisely so Claude Code's traffic works against it.
 */
export function sanitizeForAnthropicProvider(body: Record<string, unknown>): Record<string, unknown> {
  delete body.output_config;
  delete body.context_management;
  const thinking = body.thinking as Record<string, unknown> | undefined;
  // "enabled"/"disabled" are the two the spec has had all along; "adaptive" is
  // Claude-5-only and is what a GLM endpoint chokes on.
  if (thinking && thinking.type !== "enabled" && thinking.type !== "disabled") delete body.thinking;
  return body;
}

/**
 * Forward one request to an endpoint that already speaks the Messages API.
 *
 * There is no translation here and that is the entire value: tool blocks,
 * cache breakpoints, streamed thinking and the SSE event sequence all reach
 * the model exactly as the client wrote them, and come back the same way. A
 * spawned Claude Code, which is the most demanding client gate has, therefore
 * behaves against Z.AI the way it does against Anthropic — while still being
 * routed, metered and counted against the run's budget, because it is still
 * talking to gate.
 */
export async function sendToAnthropicProvider(opts: {
  provider: Provider;
  /** The upstream's own model id, without the `provider:<name>/` prefix. */
  model: string;
  /** Anthropic-dialect request body, as the router left it. */
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, model, body, stream } = opts;

  const upstreamBody = sanitizeForAnthropicProvider({ ...body, model, stream });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const key = providerApiKey(provider.id);
  // Both spellings: the Messages API takes x-api-key, and several
  // Anthropic-dialect gateways only read the bearer token.
  if (key) {
    headers["x-api-key"] = key;
    headers.Authorization = `Bearer ${key}`;
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return anthropicError(
      502,
      `Provider "${provider.label}" unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return anthropicError(res.status, text.slice(0, 2000) || `Provider returned ${res.status}`);
  }

  if (!stream) {
    // Handed back byte for byte. It is already the shape gate speaks, and the
    // model id inside it is the upstream's own — which is the truth, and what
    // the traffic log should show. gate's own name for it rides in the
    // x-gate-model header, which is where every caller reads it from.
    return new Response(res.body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!res.body) return anthropicError(502, "Provider returned no stream");
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/** Dispatch one already-routed request to whichever dialect the provider speaks. */
export function sendToProvider(opts: {
  provider: Provider;
  ref: ProviderModelRef;
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, ref, ...rest } = opts;
  return provider.kind === "anthropic-compat"
    ? sendToAnthropicProvider({ provider, model: ref.model, ...rest })
    : sendToOpenAIProvider({ provider, model: ref.model, ...rest });
}
