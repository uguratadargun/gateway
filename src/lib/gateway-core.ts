import { after } from "next/server";

import { ANTHROPIC_MESSAGES_URL } from "./claude/config";
import { applyClaudeCodeIdentity } from "./claude/identity";
import { compressBody } from "./compress";
import { cacheGet, cacheKey, cacheSet } from "./cache";
import { checkBudget } from "./budget";
import { applyReasoning } from "./reasoning";
import { recordRateLimit } from "./ratelimit";
import { loadRoutingConfig, routeModel, type RouteResult } from "./router";
import { loadSettings, type Tier } from "./settings";
import { forceRefresh, getValidCredentials } from "./token-manager";
import { recordTraffic, truncatePreview } from "./traffic";
import { recordUsage } from "./usage";
import type { StoredCredentials } from "./store";

const FALLBACK_STATUSES = new Set([429, 529]);

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { type: "gate_error", message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mutate body: compress, inject reasoning, and resolve the routed model. */
export function prepareAndRoute(
  body: Record<string, unknown>,
  effortHeader?: string | null,
): { route: RouteResult; requested: string; charsRemoved: number } {
  const requested = typeof body.model === "string" ? body.model : "(none)";
  const compression = compressBody(body);
  applyReasoning(body, effortHeader);
  const route = routeModel(typeof body.model === "string" ? body.model : undefined, body);
  body.model = route.model;
  return { route, requested, charsRemoved: compression.removed };
}

function tierModel(tier: Tier): string {
  return loadRoutingConfig().tiers[tier];
}

/**
 * Send to Anthropic with one reactive token refresh on 401 and tier fallback on
 * 429/529. Mutates body.model as it walks the fallback chain.
 */
export async function sendWithFallback(opts: {
  body: Record<string, unknown>;
  route: RouteResult;
  creds: StoredCredentials;
  clientBeta?: string | null;
}): Promise<{ upstream: Response; usedModel: string; usedTier: Tier }> {
  const { body, route, clientBeta } = opts;
  let creds = opts.creds;
  const settings = loadSettings();

  const chain: Tier[] = settings.fallback.enabled
    ? [route.tier, ...settings.fallback.chains[route.tier]]
    : [route.tier];

  let upstream!: Response;
  let usedTier: Tier = route.tier;
  let usedModel = route.model;

  for (let i = 0; i < chain.length; i++) {
    usedTier = chain[i];
    usedModel = i === 0 ? route.model : tierModel(usedTier);
    body.model = usedModel;

    const send = async (): Promise<Response> => {
      const headers = applyClaudeCodeIdentity(body, {
        accessToken: creds.accessToken,
        cliUserID: creds.cliUserID,
        accountUUID: creds.account?.account_uuid ?? null,
        model: usedModel,
      });
      if (clientBeta) {
        const set = new Set(headers["anthropic-beta"].split(",").map((s) => s.trim()));
        for (const f of clientBeta.split(",").map((s) => s.trim()).filter(Boolean)) set.add(f);
        headers["anthropic-beta"] = [...set].join(",");
      }
      return fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    };

    upstream = await send();

    if (upstream.status === 401) {
      const refreshed = await forceRefresh();
      if (refreshed) {
        creds = refreshed;
        upstream = await send();
      }
    }

    recordRateLimit(upstream.headers);

    // Success or a non-retryable status → stop. Otherwise fall to next tier.
    if (!FALLBACK_STATUSES.has(upstream.status) || i === chain.length - 1) break;
  }

  return { upstream, usedModel, usedTier };
}

/** Parse input/output tokens from an Anthropic response body. */
export async function parseUsage(
  text: string,
  contentType: string,
): Promise<{ input: number; output: number }> {
  let input = 0;
  let output = 0;
  try {
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const evt = JSON.parse(payload) as any;
        const u = evt?.message?.usage ?? evt?.usage;
        if (u) {
          if (typeof u.input_tokens === "number") input = u.input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") input += u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") input += u.cache_read_input_tokens;
          if (typeof u.output_tokens === "number") output = u.output_tokens;
        }
      }
    } else {
      const u = (JSON.parse(text) as any)?.usage;
      if (u) {
        input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        output = u.output_tokens ?? 0;
      }
    }
  } catch {
    // leave zeros
  }
  return { input, output };
}

/**
 * Full native-Anthropic pipeline for POST /v1/messages: route, budget, cache,
 * fallback, dispatch, and record usage/traffic.
 */
export async function executeMessages(
  body: Record<string, unknown>,
  opts: { stream: boolean; clientBeta?: string | null; effortHeader?: string | null },
): Promise<Response> {
  const { stream, clientBeta, effortHeader } = opts;
  const { route, requested } = prepareAndRoute(body, effortHeader);

  // Budget gate.
  const budget = checkBudget();
  if (budget.exceeded && budget.mode === "block") {
    return jsonError(402, `Budget exceeded: ${budget.reason}`);
  }

  // Only deterministic, non-streamed requests are cacheable; a sampled reply
  // (temperature > 0) is not a stable function of its input.
  const temperature = body.temperature;
  const cacheable =
    !stream && loadSettings().cache.enabled && (temperature == null || temperature === 0);
  const key = cacheable ? cacheKey(route.model, body) : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) {
      recordUsage({
        ts: Date.now(),
        requested,
        model: hit.model,
        tier: route.tier,
        reason: "cache hit",
        status: 200,
        stream: false,
        inputTokens: 0, // served from cache — no upstream tokens spent
        outputTokens: 0,
      });
      return new Response(hit.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-gate-model": hit.model,
          "x-gate-tier": route.tier,
          "x-gate-cache": "hit",
        },
      });
    }
  }

  const creds = await getValidCredentials();
  if (!creds) return jsonError(401, "No Claude account connected. Log in via the dashboard.");

  const { upstream, usedModel, usedTier } = await sendWithFallback({ body, route, creds, clientBeta });

  const ct = upstream.headers.get("content-type") ?? "";
  const respHeaders = new Headers();
  if (ct) respHeaders.set("content-type", ct);
  respHeaders.set("x-gate-model", usedModel);
  respHeaders.set("x-gate-tier", usedTier);
  respHeaders.set("x-gate-route-reason", route.reason);
  if (key) respHeaders.set("x-gate-cache", "miss");
  if (usedTier !== route.tier) respHeaders.set("x-gate-fallback", `${route.tier}->${usedTier}`);
  if (budget.exceeded && budget.mode === "warn") respHeaders.set("x-gate-budget", "exceeded");

  const base = {
    ts: Date.now(),
    requested,
    model: usedModel,
    tier: usedTier,
    reason: usedTier !== route.tier ? `${route.reason} (fallback)` : route.reason,
    status: upstream.status,
    stream,
  };

  const logTraffic = (status: number, fromCache: boolean, responsePreview: string) =>
    recordTraffic({
      ts: Date.now(),
      endpoint: "messages",
      requested,
      routed: usedModel,
      tier: usedTier,
      status,
      stream,
      fromCache,
      requestPreview: truncatePreview(JSON.stringify(body)),
      responsePreview: truncatePreview(responsePreview),
    });

  if (!upstream.body) {
    recordUsage(base);
    logTraffic(upstream.status, false, "");
    return new Response(null, { status: upstream.status, headers: respHeaders });
  }

  if (!stream) {
    // Read fully so we can cache and record exact usage.
    const text = await upstream.text();
    const usage = await parseUsage(text, ct);
    if (key && upstream.status === 200) {
      cacheSet(key, {
        body: text,
        model: usedModel,
        inputTokens: usage.input,
        outputTokens: usage.output,
      });
    }
    recordUsage({ ...base, inputTokens: usage.input, outputTokens: usage.output });
    logTraffic(upstream.status, false, text);
    return new Response(text, { status: upstream.status, headers: respHeaders });
  }

  // Streaming: tee one branch to the client, parse the other in the background.
  const [clientStream, parseStream] = upstream.body.tee();
  after(async () => {
    const text = await new Response(parseStream).text();
    const usage = await parseUsage(text, ct);
    recordUsage({ ...base, inputTokens: usage.input, outputTokens: usage.output });
    logTraffic(upstream.status, false, text);
  });
  return new Response(clientStream, { status: upstream.status, headers: respHeaders });
}
