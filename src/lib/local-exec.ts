import { anthropicToOpenAIRequest, openAIStreamToAnthropic, openAIToAnthropicResponse } from "./anthropic-openai";
import { providerApiKey, type LocalProvider } from "./local-providers";

/**
 * Send one already-routed request to an OpenAI-compatible endpoint and hand
 * back an Anthropic-shaped Response.
 *
 * That shape is the point: dispatch's usage parsing, the traffic log, the
 * response cache and every client downstream keep speaking Anthropic, so a
 * local model is a routing decision rather than a second code path.
 */

const TIMEOUT_MS = 300_000;

function anthropicError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function sendToLocalProvider(opts: {
  provider: LocalProvider;
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
      `Local provider "${provider.label}" unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return anthropicError(res.status, text.slice(0, 2000) || `Local provider returned ${res.status}`);
  }

  const modelRef = `local:${provider.name}/${model}`;

  if (!stream) {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return anthropicError(502, "Local provider returned a non-JSON response");
    return new Response(JSON.stringify(openAIToAnthropicResponse(json, modelRef)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!res.body) return anthropicError(502, "Local provider returned no stream");
  return new Response(openAIStreamToAnthropic(res.body, modelRef), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
