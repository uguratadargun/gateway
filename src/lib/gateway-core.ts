import { createHash } from "node:crypto";

import { after } from "next/server";

import { publishActivity } from "./activity";
import { ANTHROPIC_MESSAGES_URL } from "./claude/config";
import { applyClaudeCodeIdentity } from "./claude/identity";
import { checkBudget } from "./budget";
import { cacheGet, cacheKey, cacheSet } from "./cache";
import { compressBody } from "./compress";
import { countTokens } from "./count-tokens";
import { gradeDifficulty } from "./grader";
import { coalesce } from "./inflight";
import { getLimiter } from "./limiter";
import { applyPromptCaching } from "./prompt-cache";
import { currentUtilization, readRateLimit, recordRateLimit } from "./ratelimit";
import { applyReasoning, normalizeEffort, sanitizeForModel, type Effort } from "./reasoning";
import { cheaperTier, gradeToRoute, loadRoutingConfig, routeModel, TIER_RANK, type RouteResult } from "./router";
import { loadSettings, type Tier } from "./settings";
import type { StoredCredentials } from "./store";
import { forceRefresh, getValidCredentials } from "./token-manager";
import { recordTraffic, truncatePreview } from "./traffic";
import { getSessionRoute, recordUsage, setSessionRoute } from "./usage";

const FALLBACK_STATUSES = new Set([429, 529]);

export function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { type: "gate_error", message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---- Error classification --------------------------------------------------

export type ErrorClass = "ok" | "rate_limit" | "overloaded" | "auth" | "invalid" | "server" | "network";

export function classifyStatus(status: number): ErrorClass {
  if (status < 400) return "ok";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "invalid";
}

const RETRYABLE = new Set<ErrorClass>(["server", "overloaded", "network"]);

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Session detection -----------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
      .join(" ");
  }
  return "";
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const t = textOf(messages[i].content).trim();
      if (t) return t;
    }
  }
  return "";
}

/**
 * Identify the conversation this request belongs to: an explicit session header
 * (Claude Code sends X-Claude-Code-Session-Id) or a fingerprint of the stable
 * prefix (system + first user message).
 */
export interface SessionInfo {
  /** Conversation id for grouping/cost attribution (header or prompt fingerprint). */
  id: string | null;
  title: string | null;
  /**
   * Key for sticky routing. A prompt cache is keyed by tools → system →
   * messages, so a Claude Code subagent (same session header, different
   * system prompt and tools) shares no cache with its parent and must get its
   * own baseline instead of inheriting the parent's tier.
   */
  stickyKey: string | null;
}

export function sessionFromRequest(headers: Headers, body: Record<string, unknown>): SessionInfo {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const firstUser = messages.find((m) => m.role === "user");
  const firstText = textOf(firstUser?.content).trim();
  const title = firstText ? firstText.slice(0, 80) : null;

  const sys = textOf(body.system).slice(0, 4000);
  const toolNames = Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>).map((t) => String(t.name ?? "")).join(",")
    : "";
  const prefixHash = createHash("sha256").update(`${sys}\n\n${toolNames}`).digest("hex").slice(0, 12);

  const explicit = headers.get("x-gate-session") || headers.get("x-claude-code-session-id");
  if (explicit && explicit.trim()) {
    const id = explicit.trim().slice(0, 64);
    return { id, title, stickyKey: `${id}:${prefixHash}` };
  }

  if (!sys && !firstText) return { id: null, title, stickyKey: null };
  const id = createHash("sha256").update(`${sys.slice(0, 2000)}\n\n${firstText.slice(0, 500)}`).digest("hex").slice(0, 16);
  return { id, title, stickyKey: `${id}:${prefixHash}` };
}

// ---- Upstream send with refresh, retries, and tier fallback -----------------

function tierModel(tier: Tier): string {
  return loadRoutingConfig().tiers[tier];
}

/**
 * Send to Anthropic with one reactive token refresh on 401, exponential-backoff
 * retries on transient errors, short waits on 429 (per retry-after), and tier
 * fallback when a tier stays rate-limited/overloaded. Mutates body.model.
 */
export async function sendWithFallback(opts: {
  body: Record<string, unknown>;
  route: RouteResult;
  creds: StoredCredentials;
  clientBeta?: string | null;
  extraBeta?: string[];
  /** Abort the upstream call. A cancelled workflow uses this. */
  signal?: AbortSignal;
}): Promise<{ upstream: Response; usedModel: string; usedTier: Tier; attempts: number }> {
  const { body, route, clientBeta, extraBeta = [], signal } = opts;
  let creds = opts.creds;
  const settings = loadSettings();

  const chain: Tier[] = settings.fallback.enabled
    ? [route.tier, ...settings.fallback.chains[route.tier]]
    : [route.tier];

  let upstream: Response | null = null;
  let usedTier: Tier = route.tier;
  let usedModel = route.model;
  let attempts = 0;

  for (let i = 0; i < chain.length; i++) {
    usedTier = chain[i];
    usedModel = i === 0 ? route.model : tierModel(usedTier);
    body.model = usedModel;

    const send = async (): Promise<Response> => {
      // Serialize a per-attempt copy: the target model differs per tier and
      // its capabilities decide which reasoning params may go on the wire.
      const wire = structuredClone(body) as Record<string, unknown>;
      const headers = applyClaudeCodeIdentity(wire, {
        accessToken: creds.accessToken,
        cliUserID: creds.cliUserID,
        accountUUID: creds.account?.account_uuid ?? null,
        model: usedModel,
      });
      sanitizeForModel(wire, usedModel);
      const set = new Set(headers["anthropic-beta"].split(",").map((s) => s.trim()));
      for (const f of clientBeta?.split(",").map((s) => s.trim()).filter(Boolean) ?? []) set.add(f);
      for (const f of extraBeta) set.add(f);
      headers["anthropic-beta"] = [...set].join(",");
      return fetch(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(wire), signal });
    };

    let cls: ErrorClass = "network";
    // An account-wide (unified) rejection applies to every model: neither
    // retrying nor switching tier can help, so we return it immediately.
    let accountLimited = false;
    let windowFallback = false;
    for (let attempt = 0; ; attempt++) {
      attempts++;
      try {
        upstream = await send();
        if (upstream.status === 401) {
          const refreshed = await forceRefresh();
          if (refreshed) {
            creds = refreshed;
            upstream = await send();
          }
        }
        recordRateLimit(upstream.headers);
        cls = classifyStatus(upstream.status);
      } catch (e) {
        // An abort is a decision, not a transient failure: retrying it would
        // send the request the caller just cancelled.
        if (signal?.aborted) throw e;
        upstream = null;
        cls = "network";
      }

      // Context-window fallback (LiteLLM's context_window_fallbacks): a 400
      // for an oversized prompt on Haiku is retried on the 1M-window tier.
      if (cls === "invalid" && usedTier === "haiku" && upstream) {
        const errText = await upstream.clone().text().catch(() => "");
        if (/too long|too many tokens|context window|exceed/i.test(errText)) {
          if (chain[i + 1] !== "sonnet") chain.splice(i + 1, 0, "sonnet");
          windowFallback = true;
        }
      }
      if (cls === "ok" || cls === "auth" || cls === "invalid") break;

      if (RETRYABLE.has(cls) && attempt < settings.retry.maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (cls === "rate_limit") {
        accountLimited = upstream?.headers.get("anthropic-ratelimit-unified-status") === "rejected";
        const ra = Number(upstream?.headers.get("retry-after") ?? NaN);
        // A short retry-after is worth waiting out even when account-limited
        // (the window may be about to reset); otherwise stop right away.
        if (attempt < settings.retry.maxRetries) {
          const waitMs = Number.isFinite(ra) ? ra * 1000 : accountLimited ? Infinity : backoffMs(attempt);
          if (waitMs <= settings.retry.maxRateLimitWaitMs) {
            await sleep(waitMs);
            continue;
          }
        }
      }
      break;
    }

    // Only walk the fallback chain for model-specific rate-limit/overload
    // outcomes; an account-wide rejection ends the attempt.
    const fallbackable =
      windowFallback || (!accountLimited && (cls === "rate_limit" || cls === "overloaded" || cls === "network"));
    if (!fallbackable || i === chain.length - 1) break;
    if (i < chain.length - 1) {
      publishActivity({ ts: Date.now(), kind: "fallback", tier: usedTier, note: `${usedTier} → ${chain[i + 1]} (${cls})` });
    }
  }

  if (!upstream) {
    upstream = jsonError(502, "Upstream unreachable after retries");
  }
  return { upstream, usedModel, usedTier, attempts };
}

// ---- Usage parsing ---------------------------------------------------------

export interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Parse token usage (incl. prompt-cache counters) from an Anthropic response body. */
export async function parseUsage(text: string, contentType: string): Promise<ParsedUsage> {
  const out: ParsedUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const take = (u: any) => {
    if (!u) return;
    if (typeof u.input_tokens === "number") out.input = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") out.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") out.cacheCreation = u.cache_creation_input_tokens;
    if (typeof u.output_tokens === "number") out.output = u.output_tokens;
  };
  try {
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const evt = JSON.parse(payload) as any;
        take(evt?.message?.usage ?? evt?.usage);
      }
    } else {
      take((JSON.parse(text) as any)?.usage);
    }
  } catch {
    // leave zeros
  }
  return out;
}

// ---- Dispatch: the shared pipeline ----------------------------------------

export interface DispatchOptions {
  endpoint: "messages" | "chat/completions" | "responses";
  stream: boolean;
  clientBeta?: string | null;
  effortHeader?: string | null;
  session: SessionInfo;
  /** Original client request, for the traffic log. */
  requestPreview: string;
  /** Abort the upstream call; propagated to fetch. */
  signal?: AbortSignal;
}

export interface DispatchHooks {
  /** Runs after routing, before any upstream call. Return a Response to short-circuit. */
  beforeSend?: (ctx: { route: RouteResult; body: Record<string, unknown> }) => Response | null;
}

export type Dispatch =
  | { ok: false; response: Response }
  | {
      ok: true;
      upstream: Response;
      route: RouteResult;
      usedModel: string;
      usedTier: Tier;
      requested: string;
      throttled: boolean;
      headers: Headers;
      /** Record usage/traffic/activity for the finished response; releases the concurrency slot. */
      finalize: (text: string, contentType: string, extra?: { responsePreview?: string }) => ParsedUsage | Promise<ParsedUsage>;
      /** Release without recording (error paths). */
      release: () => void;
    };

/**
 * compress → route → adaptive reasoning → throttle → prompt-cache → budget →
 * hooks → concurrency slot → send (refresh/retry/fallback) → gate headers.
 */
export async function dispatch(
  body: Record<string, unknown>,
  opts: DispatchOptions,
  hooks: DispatchHooks = {},
): Promise<Dispatch> {
  const t0 = Date.now();
  const settings = loadSettings();
  const requested = typeof body.model === "string" ? body.model : "(none)";

  compressBody(body);

  // Routing (optionally with exact token counts).
  const cfg = loadRoutingConfig();
  let tokenOverride: number | undefined;
  if (settings.routingPrecision.countTokens) {
    const preliminary = routeModel(requested, body);
    tokenOverride = (await countTokens(body, preliminary.model)) ?? undefined;
  }
  let route = routeModel(requested, body, { tokenOverride });
  let categoryEffort: Effort | null = route.category ? normalizeEffort(cfg.effort[route.category]) : null;

  // LLM difficulty judge for the ambiguous middle (RouteLLM-style). Only the
  // query text is graded; the grade is cached by content hash.
  if (cfg.classifier.enabled && route.category === "default" && route.tokens >= cfg.classifier.minTokens) {
    const grade = await gradeDifficulty(lastUserText(body));
    if (grade != null) {
      const g = gradeToRoute(grade, cfg);
      route = { ...route, tier: g.tier, model: cfg.tiers[g.tier], reason: `graded ${grade}/5` };
      categoryEffort = g.effort;
    }
  }

  // Sticky session: prompt caches are per-model and effort changes invalidate
  // them, so within a conversation we never move *down* and we hold effort.
  // Background traffic (separate small prompts) and explicit heavy escalations
  // are exempt; upgrades become the new baseline.
  const stickyKey = opts.session.stickyKey;
  const sticky =
    cfg.sticky.enabled &&
    !!stickyKey &&
    route.category !== null &&
    route.category !== "background" &&
    route.category !== "heavy" &&
    route.tokens >= cfg.sticky.minTokens;
  if (sticky) {
    const prev = getSessionRoute(stickyKey!);
    if (prev?.tier && prev.tier in TIER_RANK && TIER_RANK[prev.tier as Tier] > TIER_RANK[route.tier]) {
      const t = prev.tier as Tier;
      route = { ...route, tier: t, model: cfg.tiers[t], reason: `${route.reason} (sticky ${t})` };
    }
    if (prev?.effort) categoryEffort = normalizeEffort(prev.effort);
    if (!prev?.tier || TIER_RANK[route.tier] > TIER_RANK[prev.tier as Tier]) {
      setSessionRoute(stickyKey!, route.tier, categoryEffort);
    }
  }
  body.model = route.model;

  // Effort (capability-aware): the primary cost lever.
  applyReasoning(body, opts.effortHeader, categoryEffort, route.model);

  // Soft throttle as the 5h window fills.
  let throttled = false;
  const util = settings.throttle.enabled ? currentUtilization() : null;
  if (util != null) {
    if (util >= settings.throttle.blockAt) {
      const resetAt = readRateLimit()?.resetAt ?? null;
      const retryAfter = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : 300;
      publishActivity({ ts: Date.now(), kind: "throttle", note: `blocked at ${Math.round(util * 100)}% of 5h window` });
      return {
        ok: false,
        response: jsonError(
          429,
          `gate is refusing this request: its rate-limit throttle sees the 5h window ${Math.round(util * 100)}% used ` +
            `(setting: block at ${Math.round(settings.throttle.blockAt * 100)}%). This is gate, not Anthropic. ` +
            `Turn the throttle off in Settings if the account changed.`,
          { "Retry-After": String(retryAfter) },
        ),
      };
    }
    if (util >= settings.throttle.downgradeAt) {
      const lower = cheaperTier(route.tier);
      if (lower) {
        route = { ...route, tier: lower, model: cfg.tiers[lower], reason: `${route.reason} (throttled ${Math.round(util * 100)}%)` };
        body.model = route.model;
        throttled = true;
        publishActivity({ ts: Date.now(), kind: "throttle", tier: lower, note: `downgraded to ${lower} at ${Math.round(util * 100)}%` });
      }
    }
  }

  // Prompt-cache breakpoints.
  const extraBeta: string[] = [];
  if (settings.promptCache.enabled) {
    applyPromptCaching(body, settings.promptCache.ttl);
    if (settings.promptCache.ttl === "1h") extraBeta.push("extended-cache-ttl-2025-04-11");
  }

  const budget = checkBudget();
  if (budget.exceeded && budget.mode === "block") {
    return { ok: false, response: jsonError(402, `Budget exceeded: ${budget.reason}`) };
  }

  const short = hooks.beforeSend?.({ route, body });
  if (short) return { ok: false, response: short };

  const creds = await getValidCredentials();
  if (!creds) return { ok: false, response: jsonError(401, "No Claude account connected. Log in via the dashboard.") };

  // Concurrency slot.
  let release: () => void;
  try {
    const limiter = getLimiter();
    if (limiter.stats().inFlight >= limiter.stats().max) {
      publishActivity({ ts: Date.now(), kind: "queue", note: `queued (${limiter.stats().queued + 1} waiting)` });
    }
    release = await limiter.acquire(settings.concurrency.queueTimeoutMs);
  } catch {
    return { ok: false, response: jsonError(503, "Gateway busy: queue timeout", { "Retry-After": "5" }) };
  }

  let sent: Awaited<ReturnType<typeof sendWithFallback>>;
  try {
    sent = await sendWithFallback({ body, route, creds, clientBeta: opts.clientBeta, extraBeta, signal: opts.signal });
  } catch (err) {
    release();
    return { ok: false, response: jsonError(502, err instanceof Error ? err.message : "Upstream failure") };
  }
  const { upstream, usedModel, usedTier } = sent;

  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("x-gate-model", usedModel);
  headers.set("x-gate-tier", usedTier);
  headers.set("x-gate-route-reason", route.reason);
  headers.set("x-gate-tokens-est", String(route.tokens));
  if (usedTier !== route.tier) headers.set("x-gate-fallback", `${route.tier}->${usedTier}`);
  if (throttled) headers.set("x-gate-throttled", "1");
  if (budget.exceeded && budget.mode === "warn") headers.set("x-gate-budget", "exceeded");
  if (opts.session.id) headers.set("x-gate-session", opts.session.id);

  let finalized = false;
  const finalize = async (text: string, contentType: string, extra: { responsePreview?: string } = {}) => {
    const usage = await parseUsage(text, contentType);
    if (finalized) return usage;
    finalized = true;
    release();
    recordUsage({
      ts: Date.now(),
      requested,
      model: usedModel,
      tier: usedTier,
      reason: usedTier !== route.tier ? `${route.reason} (fallback)` : route.reason,
      status: upstream.status,
      stream: opts.stream,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheCreation,
      sessionId: opts.session.id,
      sessionTitle: opts.session.title,
    });
    recordTraffic({
      ts: Date.now(),
      endpoint: opts.endpoint,
      requested,
      routed: usedModel,
      tier: usedTier,
      status: upstream.status,
      stream: opts.stream,
      fromCache: false,
      requestPreview: truncatePreview(opts.requestPreview),
      responsePreview: truncatePreview(extra.responsePreview ?? text),
    });
    publishActivity({
      ts: Date.now(),
      kind: "request",
      endpoint: opts.endpoint,
      requested,
      model: usedModel,
      tier: usedTier,
      status: upstream.status,
      stream: opts.stream,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      durationMs: Date.now() - t0,
    });
    return usage;
  };

  return {
    ok: true,
    upstream,
    route,
    usedModel,
    usedTier,
    requested,
    throttled,
    headers,
    finalize,
    release: () => {
      if (!finalized) {
        finalized = true;
        release();
      }
    },
  };
}

// ---- Native Anthropic endpoint -------------------------------------------

/** Full pipeline for POST /v1/messages, adding response cache + in-flight dedup. */
export async function executeMessages(
  body: Record<string, unknown>,
  opts: Omit<DispatchOptions, "endpoint">,
): Promise<Response> {
  const settings = loadSettings();
  const stream = opts.stream;
  const temperature = body.temperature;
  const deterministic = temperature == null || temperature === 0;
  const cacheable = !stream && settings.cache.enabled && deterministic;

  const run = async (): Promise<{ status: number; text: string; headers: Headers } | { response: Response }> => {
    let cacheKeyUsed: string | null = null;
    const d = await dispatch(body, { ...opts, endpoint: "messages" }, {
      beforeSend: ({ route, body: routed }) => {
        if (!cacheable) return null;
        cacheKeyUsed = cacheKey(route.model, routed);
        const hit = cacheGet(cacheKeyUsed);
        if (!hit) return null;
        recordUsage({
          ts: Date.now(),
          requested: typeof routed.model === "string" ? routed.model : "(none)",
          model: hit.model,
          tier: route.tier,
          reason: "cache hit",
          status: 200,
          stream: false,
          sessionId: opts.session.id,
          sessionTitle: opts.session.title,
        });
        publishActivity({ ts: Date.now(), kind: "request", endpoint: "messages", model: hit.model, tier: route.tier, status: 200, fromCache: true });
        return new Response(hit.body, {
          status: 200,
          headers: { "Content-Type": "application/json", "x-gate-model": hit.model, "x-gate-tier": route.tier, "x-gate-cache": "hit" },
        });
      },
    });
    if (!d.ok) return { response: d.response };
    if (cacheable) d.headers.set("x-gate-cache", "miss");

    if (!d.upstream.body) {
      d.release();
      return { status: d.upstream.status, text: "", headers: d.headers };
    }
    const ct = d.upstream.headers.get("content-type") ?? "";
    const text = await d.upstream.text();
    const usage = await d.finalize(text, ct);
    if (cacheKeyUsed && d.upstream.status === 200) {
      cacheSet(cacheKeyUsed, { body: text, model: d.usedModel, inputTokens: usage.input, outputTokens: usage.output });
    }
    return { status: d.upstream.status, text, headers: d.headers };
  };

  if (!stream) {
    // Dedup identical deterministic requests already in flight.
    const key = deterministic ? cacheKey(typeof body.model === "string" ? body.model : "", body) : null;
    const result = key ? await coalesce(key, run) : await run();
    if ("response" in result) return result.response;
    return new Response(result.text, { status: result.status, headers: result.headers });
  }

  const d = await dispatch(body, { ...opts, endpoint: "messages" });
  if (!d.ok) return d.response;
  if (!d.upstream.body) {
    d.release();
    return new Response(null, { status: d.upstream.status, headers: d.headers });
  }
  const ct = d.upstream.headers.get("content-type") ?? "";
  const [toClient, toParse] = d.upstream.body.tee();
  after(async () => {
    const text = await new Response(toParse).text();
    await d.finalize(text, ct);
  });
  return new Response(toClient, { status: d.upstream.status, headers: d.headers });
}
