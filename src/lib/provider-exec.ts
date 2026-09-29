import { anthropicToOpenAIRequest, openAIToAnthropicResponse } from "./anthropic-openai";
import { ANTHROPIC_VERSION, formatProviderRef, providerApiKey, type Provider, type ProviderModelRef } from "./providers";

/**
 * Send one request to a configured provider and hand back an Anthropic-shaped
 * JSON Response.
 *
 * That shape is the point: the recorder and consolidation speak Anthropic
 * whichever endpoint answers. How far the body has to travel to get there
 * depends on the dialect — a translation for `openai-compat`, a forward for
 * `anthropic-compat`. Nothing is streamed: the server's own calls read one
 * whole answer.
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
  /** The upstream's own model id, without the `provider:<name>/` prefix. */
  model: string;
  /** Anthropic-dialect request body. */
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, model, body } = opts;

  const upstreamBody = anthropicToOpenAIRequest(body, model);
  upstreamBody.stream = false;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
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

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) return anthropicError(502, "Provider returned a non-JSON response");
  return new Response(JSON.stringify(openAIToAnthropicResponse(json, formatProviderRef(provider.name, model))), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── anthropic-compat: forward, do not translate ─────────────────────────────

/**
 * Fields only Anthropic's own models take. A third-party Anthropic-dialect
 * endpoint answers 400 on them. Dropping them is not a downgrade — the target
 * model has no such knob to begin with.
 *
 * What deliberately survives: `system`, images, and `cache_control`
 * breakpoints. Those are ordinary Messages API.
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
 * There is no translation here and that is the entire value: the system
 * prompt, the messages and any cache breakpoints reach the model exactly as
 * the caller wrote them, and the answer comes back the same way.
 */
export async function sendToAnthropicProvider(opts: {
  provider: Provider;
  /** The upstream's own model id, without the `provider:<name>/` prefix. */
  model: string;
  /** Anthropic-dialect request body. */
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, model, body } = opts;

  const upstreamBody = sanitizeForAnthropicProvider({ ...body, model, stream: false });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
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

  // Handed back byte for byte: it is already the shape gate speaks. The model
  // id inside it is the upstream's own; the caller names the result by the
  // provider reference it asked for.
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Send one request to whichever dialect the provider speaks. */
export function sendToProvider(opts: {
  provider: Provider;
  ref: ProviderModelRef;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const { provider, ref, ...rest } = opts;
  return provider.kind === "anthropic-compat"
    ? sendToAnthropicProvider({ provider, model: ref.model, ...rest })
    : sendToOpenAIProvider({ provider, model: ref.model, ...rest });
}
