import { randomInt } from "node:crypto";

import { tierOf, type Tier } from "./pricing";
import type { Account, AccountQuota, QuotaWindow } from "./accounts";

/**
 * Which connected account serves this request, and how long a failed one sits
 * out. Ported from ulak-gateway's src/ulak/accountPool.ts (itself OmniRoute's
 * rotation rules): fill-first / sticky round-robin / least-used / p2c / random
 * selection, upstream Retry-After honoured first, otherwise exponential
 * backoff, and a quota-exhausted account waiting for its window to reset.
 *
 * Pure and I/O-free: callers pass the rows in and persist what comes back.
 */

export type PoolStrategy = "fill-first" | "round-robin" | "least-used" | "p2c" | "random";

export interface AccountPoolConfig {
  strategy: PoolStrategy;
  /** Requests one account serves in a row before round-robin rotates. */
  stickyRoundRobinLimit: number;
  /** Skip an account whose any window has ≤ N% left (0 = off). */
  quotaMinRemainingPercent: number;
}

export const POOL_STRATEGIES: PoolStrategy[] = [
  "fill-first",
  "round-robin",
  "least-used",
  "p2c",
  "random",
];

// ── availability ────────────────────────────────────────────────────────────

export function isCoolingDown(account: Account, now = Date.now()): boolean {
  return !!account.cooldownUntil && account.cooldownUntil > now;
}

function windowResetPassed(window: QuotaWindow, now: number): boolean {
  if (!window.resetsAt) return false;
  const reset = Date.parse(window.resetsAt);
  return Number.isFinite(reset) && reset <= now;
}

/**
 * A weekly window one model family reads, rather than one of the account-wide
 * pair. Never a reason to hold the whole account back: every other model on
 * the login reads a different window, so a model-scoped window that is out
 * becomes a ModelBlock and the account keeps serving everything else.
 */
function isModelScopedWindow(canonical: string): boolean {
  return canonical.startsWith("seven_day_") && !HIDDEN_WINDOWS.has(canonical);
}

/** Name of the first account-wide quota window at or under the floor, else null. */
export function quotaBlockedWindow(
  account: Account,
  config: AccountPoolConfig,
  now = Date.now(),
): string | null {
  if (config.quotaMinRemainingPercent <= 0 || !account.quota) return null;
  for (const [name, window] of Object.entries(account.quota.windows)) {
    if (windowResetPassed(window, now)) continue;
    // Canonical, so what comes back can be named on a screen.
    const canonical = canonicalWindowName(name);
    if (HIDDEN_WINDOWS.has(canonical) || isModelScopedWindow(canonical)) continue;
    if (100 - window.utilization <= config.quotaMinRemainingPercent) return canonical;
  }
  return null;
}

export function eligibleAccounts(
  pool: Account[],
  config: AccountPoolConfig,
  excluded: ReadonlySet<string> = new Set(),
  now = Date.now(),
  model?: string,
): Account[] {
  return pool.filter(
    (a) =>
      a.enabled &&
      !excluded.has(a.id) &&
      !isCoolingDown(a, now) &&
      quotaBlockedWindow(a, config, now) === null &&
      !(model && activeModelBlock(a, model, now)),
  );
}

/** 100 − 10·backoff − 20·lastError − 30·coolingDown − 5h pressure, floored at 0. */
export function accountHealth(account: Account, now = Date.now()): number {
  let score = 100;
  score -= (account.backoffLevel || 0) * 10;
  if (account.lastError) score -= 20;
  if (isCoolingDown(account, now)) score -= 30;
  const fiveHour = account.quota?.windows.five_hour;
  if (fiveHour && !windowResetPassed(fiveHour, now)) score -= Math.round(fiveHour.utilization / 10);
  return Math.max(0, score);
}

/** 5h utilization as a 0..1 fraction — the shape the throttle speaks. */
export function utilizationOf(account: Account, now = Date.now()): number | null {
  const window = account.quota?.windows.five_hour;
  if (!window || windowResetPassed(window, now)) return null;
  return window.utilization / 100;
}

// ── selection ───────────────────────────────────────────────────────────────

export interface SelectionResult {
  account: Account | null;
  /** Persist for the stateful strategies (sticky round-robin / least-used). */
  commit: { accountId: string; consecutiveUseCount: number } | null;
  reason: string;
}

const NONE: SelectionResult = { account: null, commit: null, reason: "no eligible account" };

function byPriority(a: Account, b: Account): number {
  return a.priority - b.priority || a.connectedAt - b.connectedAt;
}

/** Least recently used, never-used first, lower backoff first. */
function sortOldestFirst(pool: Account[]): Account[] {
  return [...pool].sort((a, b) => {
    const backoff = (a.backoffLevel || 0) - (b.backoffLevel || 0);
    if (backoff !== 0) return backoff;
    if (a.lastUsedAt === null && b.lastUsedAt === null) return byPriority(a, b);
    if (a.lastUsedAt === null) return -1;
    if (b.lastUsedAt === null) return 1;
    return a.lastUsedAt - b.lastUsedAt || byPriority(a, b);
  });
}

export function selectAccount(
  pool: Account[],
  config: AccountPoolConfig,
  options: { excluded?: ReadonlySet<string>; now?: number; isRetry?: boolean; model?: string } = {},
): SelectionResult {
  const now = options.now ?? Date.now();
  const candidates = eligibleAccounts(pool, config, options.excluded ?? new Set(), now, options.model).sort(byPriority);
  if (candidates.length === 0) return NONE;
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      account: only,
      commit: { accountId: only.id, consecutiveUseCount: (only.consecutiveUseCount || 0) + 1 },
      reason: "single candidate",
    };
  }

  switch (config.strategy) {
    case "round-robin": {
      // A retry after a failure never sticks: go straight to the LRU account.
      if (!options.isRetry) {
        const byRecency = [...candidates].sort((a, b) => {
          if (a.lastUsedAt === null && b.lastUsedAt === null) return byPriority(a, b);
          if (a.lastUsedAt === null) return 1;
          if (b.lastUsedAt === null) return -1;
          return b.lastUsedAt - a.lastUsedAt;
        });
        const current = byRecency[0];
        const count = current.consecutiveUseCount || 0;
        if (current.lastUsedAt && count < config.stickyRoundRobinLimit) {
          return {
            account: current,
            commit: { accountId: current.id, consecutiveUseCount: count + 1 },
            reason: `round-robin sticky ${count + 1}/${config.stickyRoundRobinLimit}`,
          };
        }
      }
      const next = sortOldestFirst(candidates)[0];
      return {
        account: next,
        commit: { accountId: next.id, consecutiveUseCount: 1 },
        reason: options.isRetry ? "round-robin retry → LRU" : "round-robin rotate → LRU",
      };
    }
    case "least-used": {
      const next = sortOldestFirst(candidates)[0];
      return { account: next, commit: { accountId: next.id, consecutiveUseCount: 1 }, reason: "least-used" };
    }
    case "p2c": {
      const i = randomInt(candidates.length);
      let j = randomInt(candidates.length - 1);
      if (j >= i) j += 1;
      const a = candidates[i];
      const b = candidates[j];
      const pick = accountHealth(a, now) >= accountHealth(b, now) ? a : b;
      return { account: pick, commit: null, reason: "p2c healthier of two" };
    }
    case "random":
      return { account: candidates[randomInt(candidates.length)], commit: null, reason: "random" };
    case "fill-first":
    default:
      return { account: candidates[0], commit: null, reason: "fill-first (priority order)" };
  }
}

// ── cooldown after an upstream failure ──────────────────────────────────────

/** Base 5 s, doubling per level, 2 min cap, level ≤ 15. */
export const BACKOFF = { baseMs: 5_000, maxMs: 2 * 60 * 1000, maxLevel: 15 };
/** Quota exhaustion with no known reset time. */
const QUOTA_FALLBACK_COOLDOWN_MS = 15 * 60 * 1000;
/** Never trust a reset hint further out than this (clock skew / bad parse guard). */
const MAX_HINT_COOLDOWN_MS = 8 * 60 * 60 * 1000;
/** 5xx: short and transient. */
const SERVER_ERROR_COOLDOWN_MS = 3_000;

export interface CooldownInput {
  status: number;
  /** True when the whole account was rejected, not just one model's limit. */
  quotaExhausted: boolean;
  retryAfterSeconds: number | null;
  backoffLevel: number;
  /** ISO reset of the exhausted window, when known. */
  quotaResetAt?: string | null;
  now?: number;
}

export interface CooldownDecision {
  cooldownMs: number;
  newBackoffLevel: number;
  reason: string;
}

export function computeCooldown(input: CooldownInput): CooldownDecision {
  const now = input.now ?? Date.now();
  const level = Math.max(0, input.backoffLevel || 0);

  if (input.status === 429) {
    if (input.retryAfterSeconds !== null && input.retryAfterSeconds > 0) {
      return {
        cooldownMs: Math.min(input.retryAfterSeconds * 1000, MAX_HINT_COOLDOWN_MS),
        newBackoffLevel: 0,
        reason: "retry-after",
      };
    }
    if (input.quotaExhausted) {
      const reset = input.quotaResetAt ? Date.parse(input.quotaResetAt) : NaN;
      if (Number.isFinite(reset) && reset > now) {
        return {
          cooldownMs: Math.min(reset - now, MAX_HINT_COOLDOWN_MS),
          newBackoffLevel: Math.min(level + 1, BACKOFF.maxLevel),
          reason: "quota window reset",
        };
      }
      return {
        cooldownMs: QUOTA_FALLBACK_COOLDOWN_MS,
        newBackoffLevel: Math.min(level + 1, BACKOFF.maxLevel),
        reason: "quota exhausted (no reset hint)",
      };
    }
    return {
      cooldownMs: Math.min(BACKOFF.baseMs * 2 ** level, BACKOFF.maxMs) + randomInt(1000),
      newBackoffLevel: Math.min(level + 1, BACKOFF.maxLevel),
      reason: `rate limit backoff level ${level + 1}`,
    };
  }

  if (input.status >= 500) {
    return { cooldownMs: SERVER_ERROR_COOLDOWN_MS, newBackoffLevel: level, reason: "server error" };
  }
  return { cooldownMs: 0, newBackoffLevel: level, reason: "not retryable" };
}

// ── Anthropic unified rate-limit headers → quota snapshot ───────────────────

/**
 * Header spelling → the name the usage endpoint uses, so a window read from a
 * reply and the same window read from a poll are one window and not two.
 * The pairs are Claude Code's own (`{"5h":"five_hour","7d":"seven_day","7d_oi":"seven_day_overage_included"}`);
 * `oi` is *overage included*, not Opus, and guessing otherwise mislabels it.
 */
const WINDOW_NAMES: Record<string, string> = {
  "5h": "five_hour",
  "7d": "seven_day",
  "7d_oi": "seven_day_overage_included",
};

/** The canonical name of a window, whichever spelling it arrived in. */
export function canonicalWindowName(name: string): string {
  return WINDOW_NAMES[name] ?? name;
}

function parseUtilization(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  // Claude Code captures carry a 0..1 fraction; be tolerant of percentages.
  return Math.min(100, Math.round((n <= 1 ? n * 100 : n) * 10) / 10);
}

function parseResetHeader(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/**
 * Read `anthropic-ratelimit-unified-<window>-utilization` / `-reset` pairs.
 * Null when the response carried none.
 */
export function parseUnifiedRateLimitHeaders(
  headers: Headers | Record<string, string> | null | undefined,
): AccountQuota | null {
  if (!headers) return null;
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
  const windows: Record<string, QuotaWindow> = {};
  const resets: Record<string, string | null> = {};
  for (const [key, value] of entries) {
    const util = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/.exec(key);
    if (util) {
      const name = WINDOW_NAMES[util[1]] ?? util[1];
      const utilization = parseUtilization(value);
      if (utilization !== null) windows[name] = { utilization, resetsAt: windows[name]?.resetsAt ?? null };
      continue;
    }
    const reset = /^anthropic-ratelimit-unified-([a-z0-9_]+)-reset$/.exec(key);
    if (reset) resets[WINDOW_NAMES[reset[1]] ?? reset[1]] = parseResetHeader(value);
  }
  for (const [name, resetsAt] of Object.entries(resets)) {
    if (windows[name]) windows[name].resetsAt = resetsAt;
  }
  if (Object.keys(windows).length === 0) return null;
  return { windows, source: "headers" };
}

/** The soonest reset among effectively exhausted windows, for a quota cooldown. */
export function exhaustedWindowReset(quota: AccountQuota | null | undefined, now = Date.now()): string | null {
  if (!quota) return null;
  let best: number | null = null;
  for (const [name, window] of Object.entries(quota.windows)) {
    // What recovers an account-wide rejection is an account-wide window. A
    // model-scoped one that is out would park the login for its whole week.
    if (isModelScopedWindow(canonicalWindowName(name))) continue;
    if (window.utilization < 99 || !window.resetsAt) continue;
    const reset = Date.parse(window.resetsAt);
    if (!Number.isFinite(reset) || reset <= now) continue;
    if (best === null || reset < best) best = reset;
  }
  return best === null ? null : new Date(best).toISOString();
}

// ── model-scoped rejections ─────────────────────────────────────────────────

/**
 * The weekly window each model family reads, as the usage endpoint names it.
 * Haiku has no model-scoped weekly window to hit.
 */
const TIER_WINDOWS: Record<Tier, string | null> = {
  haiku: null,
  sonnet: "seven_day_sonnet",
  opus: "seven_day_opus",
  fable: "seven_day_fable",
};

/** The scoped weekly window this model draws from, or null when it has none. */
export function modelScopedWindow(model: string): string | null {
  return TIER_WINDOWS[tierOf(model)] ?? null;
}

/**
 * One model's window being out on one account, until the window resets. The
 * account itself stays in the pool: every other model reads a different window.
 * Survives a restart on the account row.
 */
export interface ModelBlock {
  /** The scoped window that is out: "seven_day_fable". */
  window: string;
  /** The scope as the usage endpoint names it ("Fable"), when it said. */
  scope: string | null;
  /** Epoch ms the window resets at. */
  until: number;
}

export function activeModelBlocks(account: Account, now = Date.now()): ModelBlock[] {
  return (account.modelBlocks ?? []).filter((b) => b.until > now);
}

/** The block that stops this model on this account, when there is one. */
export function activeModelBlock(account: Account, model: string, now = Date.now()): ModelBlock | null {
  const window = modelScopedWindow(model);
  if (!window) return null;
  return activeModelBlocks(account, now).find((b) => b.window === window) ?? null;
}

/** Same window replaced, the others kept. */
export function upsertModelBlock(blocks: ModelBlock[] | null, block: ModelBlock): ModelBlock[] {
  return [...(blocks ?? []).filter((b) => b.window !== block.window), block];
}

export type UnifiedRejection =
  | { kind: "account" }
  | { kind: "model"; window: string; scope: string | null; until: number };

/**
 * The canonical name of a model-scoped window, or null. The account-wide pair
 * and the hidden overage window are never one, and an unknown name is not
 * judged: a guess here parks an account, or leaves it serving, on no evidence.
 */
function scopedWindowName(name: string): string | null {
  const canonical = canonicalWindowName(name);
  return isModelScopedWindow(canonical) ? canonical : null;
}

/** A weekly window is the longest reset hint there is; bound a bad parse anyway. */
const MODEL_BLOCK_MAX_MS = 8 * 24 * 60 * 60 * 1000;

function modelRejection(snapshot: AccountQuota | null | undefined, window: string, now: number): UnifiedRejection {
  const w = snapshot?.windows?.[window];
  const reset = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
  const until =
    Number.isFinite(reset) && reset > now
      ? Math.min(reset, now + MODEL_BLOCK_MAX_MS)
      : now + QUOTA_FALLBACK_COOLDOWN_MS;
  return { kind: "model", window, scope: w?.scope ?? null, until };
}

/**
 * Which claim a `rejected` unified status was about: the whole account, or one
 * model's window.
 *
 * The bare `anthropic-ratelimit-unified-status: rejected` header says only that
 * *a* claim was refused — Anthropic sets it for a spent `seven_day_fable` just
 * as for a spent account, and no reply header has ever named a model-scoped
 * window. So: a per-window `-status` header naming an account-wide window
 * decides as the whole account (the one spelling the header set is known to
 * carry); otherwise the snapshot decides — a scoped window at or above 99%
 * while `five_hour` and `seven_day` sit below it is the window that was
 * rejected. When neither source decides, the whole account is the answer, as
 * before: parking an account is the safe side of undecided.
 */
export function classifyUnifiedRejection(args: {
  headers?: Headers | Record<string, string> | null | undefined;
  snapshot: AccountQuota | null | undefined;
  model: string;
  now?: number;
}): UnifiedRejection {
  const now = args.now ?? Date.now();

  if (args.headers) {
    const entries: Array<[string, string]> =
      args.headers instanceof Headers
        ? Array.from(args.headers.entries())
        : Object.entries(args.headers).map(([k, v]) => [k.toLowerCase(), v]);
    const rejectedWide: string[] = [];
    const rejectedScoped: string[] = [];
    for (const [key, value] of entries) {
      const status = /^anthropic-ratelimit-unified-([a-z0-9_]+)-status$/.exec(key);
      if (!status || value.trim() !== "rejected") continue;
      const canonical = canonicalWindowName(status[1]);
      if (canonical === "five_hour" || canonical === "seven_day") rejectedWide.push(canonical);
      else {
        const scoped = scopedWindowName(canonical);
        if (scoped) rejectedScoped.push(scoped);
      }
    }
    if (rejectedWide.length > 0) return { kind: "account" };
    if (rejectedScoped.length > 0) {
      const wanted = modelScopedWindow(args.model);
      const window = wanted && rejectedScoped.includes(wanted) ? wanted : rejectedScoped[0];
      return modelRejection(args.snapshot, window, now);
    }
  }

  const windows = args.snapshot?.windows ?? {};
  const live = (name: string): QuotaWindow | null => {
    const w = windows[name];
    if (!w || windowResetPassed(w, now)) return null;
    return w;
  };
  // An account-wide window that is itself out ends the question.
  for (const wide of ["five_hour", "seven_day"]) {
    const w = live(wide);
    if (w && w.utilization >= 99) return { kind: "account" };
  }
  const exhausted = new Map<string, QuotaWindow>();
  for (const [name, w] of Object.entries(windows)) {
    const scoped = scopedWindowName(name);
    if (!scoped) continue;
    const q = live(name);
    if (q && q.utilization >= 99) exhausted.set(scoped, q);
  }
  const wanted = modelScopedWindow(args.model);
  const picked =
    wanted && exhausted.has(wanted) ? wanted : exhausted.size === 1 ? [...exhausted.keys()][0] : null;
  if (!picked) return { kind: "account" };
  return modelRejection(args.snapshot, picked, now);
}

// ── what the pool has left ──────────────────────────────────────────────────

export interface PoolWindow {
  /** As Anthropic names it: "five_hour", "seven_day", "seven_day_opus"… */
  name: string;
  /** Percent of the window still free, in the account best placed to serve. */
  remaining: number;
  /** When that account's window rolls over, when it said so. */
  resetsAt: string | null;
  /**
   * The label to show, when the endpoint named the window's scope itself
   * ("Fable" → "Fable limit"). Absent, `windowLabel(name)` names it.
   */
  label?: string;
}

export interface PoolQuota {
  /** 5h first, then 7d, then any per-model window, in that order. */
  windows: PoolWindow[];
  accounts: {
    total: number;
    enabled: number;
    /** Enabled, off cooldown, above the floor — the ones that can serve now. */
    available: number;
    coolingDown: number;
    /** Enabled, but held back by `quotaMinRemainingPercent`. */
    quotaBlocked: number;
    /**
     * Enabled, healthy, with one model's window out on them — serving, but not
     * for that model. A whole account cooling down is `coolingDown`; this is
     * the narrower kind, and it reads as a block on the model, not the login.
     */
    modelBlocked: number;
  };
  /** The plan behind these windows, when an account reported one. */
  plan: string | null;
  /** The freshest reading behind these numbers, or null when there is none. */
  updatedAt: number | null;
  /** The floor the pool stops serving at: 3% left can already mean none. */
  floorPercent: number;
  /** Why there are no windows, when there are none. */
  reason: string | null;
}

/**
 * The window in the words Claude Code's own `/usage` uses for it. Someone
 * reading this is reading it *because* that command stopped working here, and
 * "session limit" is the line they already know; an unmapped window keeps its
 * own name rather than being given a guessed one.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus limit",
  seven_day_sonnet: "Sonnet limit",
  seven_day_fable: "Fable limit",
  overage: "usage credit limit",
};

/**
 * Windows gate keeps but never speaks about.
 *
 * `seven_day_overage_included` is the weekly window with extra usage counted
 * on top (`oi` is *overage included*, not Opus). Anthropic sends it for some
 * accounts and not others, so it appeared on one row and was missing from the
 * next with nothing to explain the difference — and when it did appear it said
 * roughly what the weekly limit beside it already said. Nobody can act on the
 * difference: it is the same week, on the same plan.
 *
 * Hidden means hidden everywhere, including as the reason an account was held
 * back. That costs nothing: this window counts extra usage on top of the
 * weekly one, so it never has less left than the weekly window does, and the
 * weekly window reaches the quota floor first.
 */
const HIDDEN_WINDOWS = new Set(["seven_day_overage_included"]);

export function windowLabel(name: string, scope?: string | null): string {
  if (scope) return `${scope} limit`;
  const canonical = canonicalWindowName(name);
  return WINDOW_LABELS[canonical] ?? canonical.replace(/_/g, " ");
}

function windowRank(name: string): number {
  if (name === "five_hour") return 0;
  if (name === "seven_day") return 1;
  return 2;
}

function sortWindows(windows: PoolWindow[]): PoolWindow[] {
  return windows.sort((a, b) => windowRank(a.name) - windowRank(b.name) || a.name.localeCompare(b.name));
}

/**
 * One account's windows: canonical names, ordered, and read as percent *left*.
 *
 * The same window can sit in a snapshot twice — once under the header spelling
 * a previous build stored (`7d`) and once under the name the usage endpoint
 * uses. The canonical key wins, because that is the one both sources write now
 * and the alias is frozen at whatever it last said. A hidden window is dropped
 * here rather than at each screen, so every surface that reports windows —
 * the accounts card, the pool's quota, `gate usage` — agrees on the list.
 */
export function accountWindows(account: Account, now = Date.now()): PoolWindow[] {
  const byName = new Map<string, { window: QuotaWindow; canonical: boolean }>();
  for (const [key, window] of Object.entries(account.quota?.windows ?? {})) {
    const name = canonicalWindowName(key);
    if (HIDDEN_WINDOWS.has(name)) continue;
    const canonical = key === name;
    const held = byName.get(name);
    if (held && (held.canonical || !canonical)) continue;
    byName.set(name, { window, canonical });
  }

  return sortWindows(
    [...byName.entries()].map(([name, { window }]) => {
      // A window whose reset has passed is full again; the snapshot just has not
      // been overwritten yet, because that only happens on the next reply.
      const done = windowResetPassed(window, now);
      return {
        name,
        remaining: done ? 100 : Math.round(Math.max(0, 100 - window.utilization) * 10) / 10,
        resetsAt: done ? null : window.resetsAt,
        ...(window.scope ? { label: windowLabel(name, window.scope) } : {}),
      };
    }),
  );
}

/**
 * How much of its quota the pool still has — the answer to "can I keep working".
 *
 * A request goes to whichever account can serve it, so the pool's remaining
 * percent is the *best* of those accounts, not their average: two accounts at
 * 90% used and one fresh one means a fresh window, and averaging them would say
 * otherwise. When none can serve, the enabled ones are still what the person is
 * waiting on — reporting their exhausted windows and reset times is the useful
 * answer, and reporting nothing is not.
 *
 * Pure, like the rest of this module: the caller lists the accounts and decides
 * whether to refresh them first.
 */
export function poolQuota(pool: Account[], config: AccountPoolConfig, now = Date.now(), model?: string): PoolQuota {
  const enabled = pool.filter((a) => a.enabled);
  const available = eligibleAccounts(enabled, config, new Set(), now, model);
  const speaking = available.length ? available : enabled;

  const best = new Map<string, PoolWindow>();
  for (const account of speaking) {
    for (const window of accountWindows(account, now)) {
      const current = best.get(window.name);
      if (current && current.remaining >= window.remaining) continue;
      best.set(window.name, window);
    }
  }
  const windows = sortWindows([...best.values()]);

  const fetched = speaking.map((a) => a.quotaFetchedAt).filter((t): t is number => typeof t === "number");
  const accounts = {
    total: pool.length,
    enabled: enabled.length,
    available: available.length,
    coolingDown: enabled.filter((a) => isCoolingDown(a, now)).length,
    quotaBlocked: enabled.filter((a) => !isCoolingDown(a, now) && quotaBlockedWindow(a, config, now) !== null).length,
    modelBlocked: enabled.filter(
      (a) => !isCoolingDown(a, now) && (model ? activeModelBlock(a, model, now) : activeModelBlocks(a, now).length > 0),
    ).length,
  };

  return {
    windows,
    accounts,
    plan: speaking.map((a) => a.quota?.plan ?? a.planTier).find((p) => !!p) ?? null,
    updatedAt: fetched.length ? Math.max(...fetched) : null,
    floorPercent: config.quotaMinRemainingPercent,
    reason: windows.length ? null : noWindowsReason(pool, enabled, speaking),
  };
}

function noWindowsReason(pool: Account[], enabled: Account[], speaking: Account[]): string {
  if (pool.length === 0) return "no Claude account is connected to this gate";
  if (enabled.length === 0) return "every connected account is paused";
  const error = speaking.map((a) => a.quota?.error).find((e) => !!e);
  if (error) return `Claude's usage endpoint refused the last poll: ${error}`;
  return "no window reading yet — an account reports one once it serves a request or is polled";
}

/** Merge a fresh header snapshot over the stored one; null when nothing moved. */
export function mergeQuota(previous: AccountQuota | null, incoming: AccountQuota | null): AccountQuota | null {
  if (!incoming) return null;
  const changed =
    !previous ||
    Object.entries(incoming.windows).some(
      ([name, window]) =>
        previous.windows[name]?.utilization !== window.utilization ||
        (window.resetsAt && previous.windows[name]?.resetsAt !== window.resetsAt),
    );
  if (!changed) return null;
  return {
    windows: { ...(previous?.windows ?? {}), ...incoming.windows },
    plan: previous?.plan ?? null,
    source: incoming.source,
    polledAt: incoming.polledAt ?? previous?.polledAt ?? null,
  };
}
