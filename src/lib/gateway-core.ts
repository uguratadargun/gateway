import { createHash } from "node:crypto";

import { after } from "next/server";

import {
  clearAccountFailure,
  listAccounts,
  saveAccountQuota,
  setAccountCooldown,
  touchAccountUse,
  type Account,
} from "./accounts";
import {
  computeCooldown,
  exhaustedWindowReset,
  mergeQuota,
  parseUnifiedRateLimitHeaders,
  selectAccount,
  utilizationOf,
  type AccountPoolConfig,
} from "./account-pool";
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
import { sendToLocalProvider } from "./local-exec";
import { getProviderByName, parseLocalRef, type LocalModelRef } from "./local-providers";
import { applyPromptCaching } from "./prompt-cache";
import { currentUtilization, readRateLimit, recordRateLimit } from "./ratelimit";
import { applyReasoning, normalizeEffort, sanitizeForModel, type Effort } from "./reasoning";
import { cheaperTier, gradeToRoute, loadRoutingConfig, routeModel, TIER_RANK, type RouteResult } from "./router";
import { loadSettings, type Tier } from "./settings";
import { forceRefreshFor, getValidCredentialsFor } from "./token-manager";
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

// ---- Upstream send: refresh, retries, account rotation, tier fallback -------

function tierModel(tier: Tier): string {
  return loadRoutingConfig().tiers[tier];
}

export interface SendOutcome {
  upstream: Response;
  usedModel: string;
  usedTier: Tier;
  attempts: number;
  /** The Claude account that served the final attempt; null for a local route. */
  accountId: string | null;
  /** The local provider that served it; null when Anthropic did. */
  providerId: string | null;
}

/**
 * Anthropic sets the unified rate-limit headers on every reply, so the pool's
 * view of an account's 5h/7d windows stays fresh without polling anything.
 */
function captureQuota(account: Account, headers: Headers): void {
  const merged = mergeQuota(account.quota, parseUnifiedRateLimitHeaders(headers));
  if (!merged) return;
  try {
    saveAccountQuota(account.id, merged);
    // Keep the in-memory row honest: the throttle and the next selection in
    // this same request read it.
    account.quota = merged;
  } catch {
    // bookkeeping must never break the response path
  }
}

/**
 * Sit a failed account out. Upstream Retry-After wins; a quota-exhausted
 * account waits for its window to reset; anything else backs off
 * exponentially. Ported from ulak-gateway's accountFallback rules.
 */
function coolDownAccount(account: Account, upstream: Response | null, quotaExhausted: boolean): void {
  const status = upstream?.status ?? 502;
  const retryAfter = Number(upstream?.headers.get("retry-after") ?? NaN);
  const headerQuota = upstream ? parseUnifiedRateLimitHeaders(upstream.headers) : null;
  const decision = computeCooldown({
    status,
    quotaExhausted,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    backoffLevel: account.backoffLevel,
    quotaResetAt:
      exhaustedWindowReset(headerQuota) ??
      exhaustedWindowReset(account.quota) ??
      headerQuota?.windows.five_hour?.resetsAt ??
      account.quota?.windows.five_hour?.resetsAt ??
      null,
  });
  if (decision.cooldownMs <= 0) return;
  try {
    setAccountCooldown(
      account.id,
      Date.now() + decision.cooldownMs,
      `[${status}] ${decision.reason}`,
      decision.newBackoffLevel,
    );
  } catch {
    // best-effort
  }
}

/** 401 that survived a refresh: the account is dead until the user re-links it. */
const AUTH_REJECTED_COOLDOWN_MS = 60_000;

interface AttemptResult {
  upstream: Response | null;
  cls: ErrorClass;
  /** The whole account was rejected, not just this model's limit. */
  accountLimited: boolean;
  /** A 400 for an oversized prompt; the caller inserts a wider tier. */
  windowFallback: boolean;
}

/**
 * Send to Anthropic on one account, with a reactive token refresh on 401,
 * exponential-backoff retries on transient errors, and short waits on 429.
 */
async function attemptOnAccount(args: {
  account: Account;
  body: Record<string, unknown>;
  usedModel: string;
  usedTier: Tier;
  clientBeta?: string | null;
  extraBeta: string[];
  signal?: AbortSignal;
  onAttempt: () => void;
  /** Only a single-account gate has a meaningful global rate-limit series. */
  poolSize: number;
}): Promise<AttemptResult> {
  const { account, body, usedModel, usedTier, clientBeta, extraBeta, signal, onAttempt, poolSize } = args;
  const settings = loadSettings();

  let creds = await getValidCredentialsFor(account.id);
  if (!creds) {
    return { upstream: jsonError(401, `Account "${account.label}" has no usable credentials.`), cls: "auth", accountLimited: false, windowFallback: false };
  }

  const send = async (): Promise<Response> => {
    // Serialize a per-attempt copy: the target model differs per tier and its
    // capabilities decide which reasoning params may go on the wire.
    const wire = structuredClone(body) as Record<string, unknown>;
    const headers = applyClaudeCodeIdentity(wire, {
      accessToken: creds!.accessToken,
      cliUserID: creds!.cliUserID,
      accountUUID: creds!.account?.account_uuid ?? null,
      model: usedModel,
    });
    sanitizeForModel(wire, usedModel);
    const set = new Set(headers["anthropic-beta"].split(",").map((s) => s.trim()));
    for (const f of clientBeta?.split(",").map((s) => s.trim()).filter(Boolean) ?? []) set.add(f);
    for (const f of extraBeta) set.add(f);
    headers["anthropic-beta"] = [...set].join(",");
    return fetch(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(wire), signal });
  };

  let upstream: Response | null = null;
  let cls: ErrorClass = "network";
  let accountLimited = false;
  let windowFallback = false;

  for (let attempt = 0; ; attempt++) {
    onAttempt();
    try {
      upstream = await send();
      if (upstream.status === 401) {
        const refreshed = await forceRefreshFor(account.id);
        if (refreshed) {
          creds = refreshed;
          upstream = await send();
        }
      }
      recordRateLimit(upstream.headers, { history: poolSize <= 1 });
      captureQuota(account, upstream.headers);
      cls = classifyStatus(upstream.status);
    } catch (e) {
      // An abort is a decision, not a transient failure: retrying it would
      // send the request the caller just cancelled.
      if (signal?.aborted) throw e;
      upstream = null;
      cls = "network";
    }

    // Context-window fallback (LiteLLM's context_window_fallbacks): a 400 for
    // an oversized prompt on Haiku is retried on the 1M-window tier.
    if (cls === "invalid" && usedTier === "haiku" && upstream) {
      const errText = await upstream.clone().text().catch(() => "");
      if (/too long|too many tokens|context window|exceed/i.test(errText)) windowFallback = true;
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
      // (the window may be about to reset); otherwise hand back to the pool.
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

  return { upstream, cls, accountLimited, windowFallback };
}

/** Send to a configured OpenAI-compatible endpoint, with transient retries. */
async function attemptOnProvider(args: {
  ref: LocalModelRef;
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
  onAttempt: () => void;
}): Promise<AttemptResult & { providerId: string | null }> {
  const { ref, body, stream, signal, onAttempt } = args;
  const settings = loadSettings();
  const provider = getProviderByName(ref.provider);

  if (!provider || !provider.enabled) {
    return {
      upstream: jsonError(
        502,
        `Local provider "${ref.provider}" is ${provider ? "disabled" : "not configured"}. Add it under Local models, or point this tier at a Claude model.`,
      ),
      // Treated as a network failure so the tier chain still has somewhere to
      // go: an unplugged local box should not take the whole request down.
      cls: "network",
      accountLimited: false,
      windowFallback: false,
      providerId: provider?.id ?? null,
    };
  }

  let upstream: Response | null = null;
  let cls: ErrorClass = "network";
  for (let attempt = 0; ; attempt++) {
    onAttempt();
    try {
      upstream = await sendToLocalProvider({
        provider,
        model: ref.model,
        body: structuredClone(body) as Record<string, unknown>,
        stream,
        signal,
      });
      cls = classifyStatus(upstream.status);
    } catch (e) {
      if (signal?.aborted) throw e;
      upstream = null;
      cls = "network";
    }
    if (!RETRYABLE.has(cls) || attempt >= settings.retry.maxRetries) break;
    await sleep(backoffMs(attempt));
  }
  return { upstream, cls, accountLimited: false, windowFallback: false, providerId: provider.id };
}

/**
 * Serve one routed request. Within a tier the pool is walked first — a
 * rate-limited account is cooled down and the next one takes over, because a
 * second login has the quota a cheaper model would only approximate. Only when
 * no account is left does the tier fallback chain drop a rung.
 */
export async function sendWithFallback(opts: {
  body: Record<string, unknown>;
  route: RouteResult;
  /** The account picked by dispatch; null when the route starts on a local model. */
  account: Account | null;
  pool: Account[];
  poolConfig: AccountPoolConfig;
  stream: boolean;
  clientBeta?: string | null;
  extraBeta?: string[];
  /** Abort the upstream call. A cancelled workflow uses this. */
  signal?: AbortSignal;
}): Promise<SendOutcome> {
  const { body, route, pool, poolConfig, stream, clientBeta, extraBeta = [], signal } = opts;
  const settings = loadSettings();

  const chain: Tier[] = settings.fallback.enabled
    ? [route.tier, ...settings.fallback.chains[route.tier]]
    : [route.tier];

  let upstream: Response | null = null;
  let usedTier: Tier = route.tier;
  let usedModel = route.model;
  let attempts = 0;
  let accountId: string | null = null;
  let providerId: string | null = null;
  let account = opts.account;
  /** Accounts already cooled down while serving this one request. */
  const spent = new Set<string>();
  const onAttempt = () => {
    attempts++;
  };

  for (let i = 0; i < chain.length; i++) {
    usedTier = chain[i];
    usedModel = i === 0 ? route.model : tierModel(usedTier);
    body.model = usedModel;

    let cls: ErrorClass = "network";
    let accountLimited = false;
    let windowFallback = false;

    const local = parseLocalRef(usedModel);
    if (local) {
      accountId = null;
      const result = await attemptOnProvider({ ref: local, body, stream, signal, onAttempt });
      upstream = result.upstream;
      cls = result.cls;
      providerId = result.providerId;
    } else {
      providerId = null;
      for (;;) {
        if (!account) {
          const pick = selectAccount(pool, poolConfig, { excluded: spent, isRetry: true });
          if (!pick.account) break;
          account = pick.account;
          if (pick.commit) touchAccountUse(pick.commit.accountId, pick.commit.consecutiveUseCount);
          publishActivity({
            ts: Date.now(),
            kind: "fallback",
            tier: usedTier,
            note: `account → ${account.label} (${pick.reason})`,
          });
        }
        accountId = account.id;

        const result = await attemptOnAccount({
          account,
          body,
          usedModel,
          usedTier,
          clientBeta,
          extraBeta,
          signal,
          onAttempt,
          poolSize: pool.length,
        });
        upstream = result.upstream;
        cls = result.cls;
        accountLimited = result.accountLimited;
        windowFallback = windowFallback || result.windowFallback;

        if (cls === "ok") {
          clearAccountFailure(account.id);
          break;
        }
        // An account-wide rejection or a dead token is this login's problem,
        // not this tier's: no cheaper model on the same account would be
        // served either, so park it and let the next login serve this model.
        // A *model-specific* 429 is left alone deliberately — the account is
        // fine, and the tier chain below is the cheaper answer.
        if (cls === "auth" || (cls === "rate_limit" && accountLimited)) {
          if (cls === "auth") {
            setAccountCooldown(account.id, Date.now() + AUTH_REJECTED_COOLDOWN_MS, "[401] upstream auth rejected");
          } else {
            coolDownAccount(account, upstream, true);
          }
          spent.add(account.id);
          account = null;
          continue;
        }
        break;
      }
      // Every account is spent. A cheaper tier is served by the same exhausted
      // logins, so there is nothing left to try.
      if (!account) break;
    }

    // Context-window fallback: retry an oversized Haiku prompt on Sonnet.
    if (windowFallback && chain[i + 1] !== "sonnet") chain.splice(i + 1, 0, "sonnet");

    // Only walk the fallback chain for model-specific rate-limit/overload
    // outcomes; an account-wide rejection with no spare account ends it.
    const fallbackable =
      windowFallback || (!accountLimited && (cls === "rate_limit" || cls === "overloaded" || cls === "network"));
    if (!fallbackable || i === chain.length - 1) break;
    publishActivity({
      ts: Date.now(),
      kind: "fallback",
      tier: usedTier,
      note: `${usedTier} → ${chain[i + 1]} (${cls})`,
    });
  }

  if (!upstream) upstream = jsonError(502, "Upstream unreachable after retries");
  return { upstream, usedModel, usedTier, attempts, accountId, providerId };
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

  // Which login serves this request, and whether its 5h window still has room.
  // A route that already points at a local model needs no Claude account.
  const pool = listAccounts();
  const poolConfig = settings.accountPool;
  let account: Account | null = null;
  let throttled = false;

  if (!parseLocalRef(route.model)) {
    if (pool.length === 0) {
      return { ok: false, response: jsonError(401, "No Claude account connected. Log in via the dashboard.") };
    }
    // An account past the ceiling is skipped, not refused — having a second
    // login is exactly what should keep the request alive.
    const overCeiling = new Set<string>();
    for (;;) {
      const pick = selectAccount(pool, poolConfig, { excluded: overCeiling });
      if (!pick.account) break;
      // Per-account quota only exists once Anthropic has answered on that
      // login. With a single account the pre-pool global snapshot is the same
      // reading, so the throttle still works on the first request after an
      // upgrade, before any per-account quota has been captured.
      const util = settings.throttle.enabled
        ? utilizationOf(pick.account) ?? (pool.length === 1 ? currentUtilization() : null)
        : null;
      if (util != null && util >= settings.throttle.blockAt) {
        overCeiling.add(pick.account.id);
        continue;
      }
      account = pick.account;
      if (pick.commit) touchAccountUse(pick.commit.accountId, pick.commit.consecutiveUseCount);
      if (util != null && util >= settings.throttle.downgradeAt) {
        const lower = cheaperTier(route.tier);
        if (lower) {
          route = { ...route, tier: lower, model: cfg.tiers[lower], reason: `${route.reason} (throttled ${Math.round(util * 100)}%)` };
          body.model = route.model;
          throttled = true;
          publishActivity({ ts: Date.now(), kind: "throttle", tier: lower, note: `downgraded to ${lower} at ${Math.round(util * 100)}%` });
        }
      }
      break;
    }

    if (!account) {
      const resetAt = readRateLimit()?.resetAt ?? null;
      const retryAfter = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : 300;
      publishActivity({ ts: Date.now(), kind: "throttle", note: `no account available (${pool.length} connected)` });
      return {
        ok: false,
        response: jsonError(
          429,
          `gate is refusing this request: none of the ${pool.length} connected Claude account(s) can serve it — ` +
            `each is either cooling down after a rate limit or past the throttle ceiling ` +
            `(setting: block at ${Math.round(settings.throttle.blockAt * 100)}% of the 5h window). ` +
            `This is gate, not Anthropic. Connect another account, or turn the throttle off in Settings.`,
          { "Retry-After": String(retryAfter) },
        ),
      };
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
    sent = await sendWithFallback({
      body,
      route,
      account,
      pool,
      poolConfig,
      stream: opts.stream,
      clientBeta: opts.clientBeta,
      extraBeta,
      signal: opts.signal,
    });
  } catch (err) {
    release();
    return { ok: false, response: jsonError(502, err instanceof Error ? err.message : "Upstream failure") };
  }
  const { upstream, usedModel, usedTier, accountId, providerId } = sent;

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
  // Ids, not labels: a header must stay ASCII and a label is user-editable.
  if (accountId) headers.set("x-gate-account", accountId);
  if (providerId) headers.set("x-gate-provider", providerId);

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
      accountId,
      providerId,
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
      accountId,
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
