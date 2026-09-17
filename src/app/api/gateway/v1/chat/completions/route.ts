import { after } from "next/server";

import { gatePrincipal } from "@/lib/gate-auth";
import { dispatch, jsonError, sessionFromRequest } from "@/lib/gateway-core";
import { anthropicStreamToOpenAI, anthropicToOpenAI, openaiToAnthropic } from "@/lib/openai-compat";

export const runtime = "nodejs";
export const maxDuration = 600;

/** OpenAI Chat Completions-compatible endpoint backed by Claude. */
export async function POST(req: Request) {
  // The principal, not just whether there is one: the traffic log names it.
  const caller = gatePrincipal(req);
  if (!caller) return jsonError(401, "Invalid gate API key");

  let oaiReq: Record<string, unknown>;
  try {
    oaiReq = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const stream = oaiReq.stream === true;
  const body = openaiToAnthropic(oaiReq);
  const d = await dispatch(body, {
    endpoint: "chat/completions",
    stream,
    clientBeta: req.headers.get("anthropic-beta"),
    effortHeader: req.headers.get("x-gate-effort"),
    session: sessionFromRequest(req.headers, body),
    requestPreview: JSON.stringify(oaiReq),
    caller,
  });
  if (!d.ok) return d.response;

  const ct = d.upstream.headers.get("content-type") ?? "";
  const gateHeaders: Record<string, string> = {};
  d.headers.forEach((v, k) => {
    if (k.startsWith("x-gate-")) gateHeaders[k] = v;
  });

  if (d.upstream.status >= 400 || !d.upstream.body) {
    const text = d.upstream.body ? await d.upstream.text() : "";
    await d.finalize(text, ct);
    return new Response(JSON.stringify({ error: { message: text || "upstream error", type: "gate_error" } }), {
      status: d.upstream.status,
      headers: { "Content-Type": "application/json", ...gateHeaders },
    });
  }

  if (!stream) {
    const text = await d.upstream.text();
    await d.finalize(text, ct);
    let anthropicJson: Record<string, unknown> = {};
    try {
      anthropicJson = JSON.parse(text);
    } catch {
      // leave empty
    }
    return Response.json(anthropicToOpenAI(anthropicJson, d.usedModel), { headers: gateHeaders });
  }

  const [toClient, toParse] = d.upstream.body.tee();
  after(async () => {
    const text = await new Response(toParse).text();
    await d.finalize(text, ct);
  });
  return new Response(anthropicStreamToOpenAI(toClient, d.usedModel), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...gateHeaders },
  });
}
