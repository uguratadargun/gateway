import { checkBudget } from "@/lib/budget";
import {
  jsonError,
  parseUsage,
  prepareAndRoute,
  sendWithFallback,
} from "@/lib/gateway-core";
import {
  anthropicStreamToOpenAI,
  anthropicToOpenAI,
  openaiToAnthropic,
} from "@/lib/openai-compat";
import { gateAuthOk } from "@/lib/gate-auth";
import { getValidCredentials } from "@/lib/token-manager";
import { recordTraffic, truncatePreview } from "@/lib/traffic";
import { recordUsage } from "@/lib/usage";
import { after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

/** OpenAI Chat Completions-compatible endpoint backed by Claude. */
export async function POST(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");

  let oaiReq: Record<string, unknown>;
  try {
    oaiReq = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const stream = oaiReq.stream === true;
  const body = openaiToAnthropic(oaiReq);
  const { route, requested } = prepareAndRoute(body, req.headers.get("x-gate-effort"));

  const budget = checkBudget();
  if (budget.exceeded && budget.mode === "block") {
    return jsonError(402, `Budget exceeded: ${budget.reason}`);
  }

  const creds = await getValidCredentials();
  if (!creds) return jsonError(401, "No Claude account connected. Log in via the dashboard.");

  const { upstream, usedModel, usedTier } = await sendWithFallback({
    body,
    route,
    creds,
    clientBeta: req.headers.get("anthropic-beta"),
  });

  const base = {
    ts: Date.now(),
    requested,
    model: usedModel,
    tier: usedTier,
    reason: usedTier !== route.tier ? `${route.reason} (fallback)` : route.reason,
    status: upstream.status,
    stream,
  };
  const logTraffic = (status: number, preview: string) =>
    recordTraffic({
      ts: Date.now(),
      endpoint: "chat/completions",
      requested,
      routed: usedModel,
      tier: usedTier,
      status,
      stream,
      fromCache: false,
      requestPreview: truncatePreview(JSON.stringify(oaiReq)),
      responsePreview: truncatePreview(preview),
    });

  // Upstream error → pass through as an OpenAI-style error.
  if (upstream.status >= 400 || !upstream.body) {
    const text = upstream.body ? await upstream.text() : "";
    recordUsage(base);
    logTraffic(upstream.status, text);
    return new Response(
      JSON.stringify({ error: { message: text || "upstream error", type: "gate_error" } }),
      { status: upstream.status, headers: { "Content-Type": "application/json" } },
    );
  }

  const ct = upstream.headers.get("content-type") ?? "";

  if (!stream) {
    const text = await upstream.text();
    const usage = await parseUsage(text, ct);
    recordUsage({ ...base, inputTokens: usage.input, outputTokens: usage.output });
    logTraffic(upstream.status, text);
    let anthropicJson: Record<string, unknown> = {};
    try {
      anthropicJson = JSON.parse(text);
    } catch {
      // leave empty
    }
    return Response.json(anthropicToOpenAI(anthropicJson, usedModel), {
      headers: { "x-gate-model": usedModel, "x-gate-tier": usedTier },
    });
  }

  // Streaming: tee — one branch translates to the client, one records usage.
  const [toClient, toParse] = upstream.body.tee();
  after(async () => {
    const text = await new Response(toParse).text();
    const usage = await parseUsage(text, ct);
    recordUsage({ ...base, inputTokens: usage.input, outputTokens: usage.output });
    logTraffic(upstream.status, text);
  });

  return new Response(anthropicStreamToOpenAI(toClient, usedModel), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-gate-model": usedModel,
      "x-gate-tier": usedTier,
    },
  });
}
