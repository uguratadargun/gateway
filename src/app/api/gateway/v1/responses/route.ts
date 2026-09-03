import { after } from "next/server";

import { gateAuthOk } from "@/lib/gate-auth";
import { dispatch, jsonError, sessionFromRequest } from "@/lib/gateway-core";
import { anthropicStreamToResponses, anthropicToResponses, responsesToAnthropic } from "@/lib/openai-responses";

export const runtime = "nodejs";
export const maxDuration = 600;

const EFFORT_MAP: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high" };

/** OpenAI Responses API-compatible endpoint (Codex CLI, new OpenAI SDKs). */
export async function POST(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");

  let oaiReq: Record<string, unknown>;
  try {
    oaiReq = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const stream = oaiReq.stream === true;
  const { body, effort } = responsesToAnthropic(oaiReq);
  const d = await dispatch(body, {
    endpoint: "responses",
    stream,
    clientBeta: req.headers.get("anthropic-beta"),
    effortHeader: req.headers.get("x-gate-effort") ?? (effort ? EFFORT_MAP[effort] ?? null : null),
    session: sessionFromRequest(req.headers, body),
    requestPreview: JSON.stringify(oaiReq),
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
    return Response.json(anthropicToResponses(anthropicJson, d.usedModel), { headers: gateHeaders });
  }

  const [toClient, toParse] = d.upstream.body.tee();
  after(async () => {
    const text = await new Response(toParse).text();
    await d.finalize(text, ct);
  });
  return new Response(anthropicStreamToResponses(toClient, d.usedModel), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...gateHeaders },
  });
}
