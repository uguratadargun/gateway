import type { Account, AccountQuota, QuotaWindow } from "../accounts";
import { listAccounts, saveAccountQuota } from "../accounts";
import { getValidCredentialsFor } from "../token-manager";
import { ANTHROPIC_OAUTH_USAGE_URL, CLAUDE_CODE_VERSION } from "./config";

/**
 * Claude's own quota endpoint. The unified rate-limit headers only arrive on a
 * real reply, so a freshly connected account has no window reading at all until
 * it serves traffic — and the pool's quota floor and the throttle would both be
 * flying blind on it. This asks Anthropic directly, sending no inference.
 *
 * Ported from ulak-gateway's src/claude/usage.ts. Anthropic rate-limits this
 * endpoint separately from /v1/messages; a 429 here pauses polling for that
 * token for three minutes and leaves chat untouched.
 */

const TIMEOUT_MS = 10_000;
const USAGE_429_COOLDOWN_MS = 180_000;
/** First wait after a failed poll; doubles per consecutive failure. */
const FAILURE_BACKOFF_BASE_MS = 10 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 4 * 60 * 60_000;

/** Keyed by access token, so a rotated token starts clean. */
const cooldown = new Map<string, number>();

/**
 * One poll per account at a time. The dashboard and the startup daemon both
 * refresh stale accounts, and at boot they fire together — without this the
 * same account is polled twice before either writes `quotaFetchedAt`, which is
 * exactly what earns a 429 from an endpoint Anthropic limits separately.
 */
const inflight = new Map<string, Promise<UsageFetchResult>>();

/**
 * Consecutive failures per account, and the earliest time to try again.
 * The interval alone is not enough protection: an account that keeps failing
 * would be retried on that interval forever, and the endpoint answering 429 is
 * precisely the case where asking again soon is worst.
 */
const failures = new Map<string, number>();
const nextAttempt = new Map<string, number>();

function recordPollOutcome(accountId: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    failures.delete(accountId);
    nextAttempt.delete(accountId);
    return;
  }
  const n = (failures.get(accountId) ?? 0) + 1;
  failures.set(accountId, n);
  nextAttempt.set(accountId, now + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (n - 1), FAILURE_BACKOFF_MAX_MS));
}

/** Test hook. */
export function _resetQuotaPollState(): void {
  cooldown.clear();
  failures.clear();
  nextAttempt.clear();
  inflight.clear();
}

function coolingDown(accessToken: string, now = Date.now()): boolean {
  const until = cooldown.get(accessToken);
  if (until === undefined) return false;
  if (until > now) return true;
  cooldown.delete(accessToken);
  return false;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function percent(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  // This endpoint reports percent USED; be tolerant of a 0..1 fraction too.
  return Math.min(100, Math.max(0, Math.round((n <= 1 ? n * 100 : n) * 10) / 10));
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000).toISOString();
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/** "Fable" → "fable", "Claude Opus 4" → "claude_opus_4": a scope as a window-name suffix. */
function scopeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The name a `limits` entry goes under, or null for one that is not a window.
 *
 * The endpoint now describes every limit twice: the legacy top-level keys
 * (`five_hour`, `seven_day`, `seven_day_opus`…) and a `limits` list whose
 * entries carry a `kind`, a percent and a scope. The model-scoped weekly
 * limit — the one Claude Code shows as "Fable limit" — exists **only** in the
 * list: its legacy key is `null`, and there is no `seven_day_fable`. So the
 * list is read too, named the way the legacy keys would have named it, and a
 * window the legacy keys already gave is not given twice.
 */
function limitWindowName(entry: Record<string, unknown>): { name: string; scope: string | null } | null {
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const scope = toRecord(entry.scope);
  const model = toRecord(scope.model);
  const scopeName =
    (typeof model.display_name === "string" && model.display_name.trim()) ||
    (typeof model.id === "string" && model.id.trim()) ||
    (typeof scope.surface === "string" && scope.surface.trim()) ||
    "";
  if (kind === "session") return { name: "five_hour", scope: null };
  if (kind === "weekly_all") return { name: "seven_day", scope: null };
  if (kind === "weekly_scoped" && scopeName) return { name: `seven_day_${scopeSlug(scopeName)}`, scope: scopeName };
  return null;
}

/** Pure: the usage payload → a quota snapshot, or null when it carried no window. */
export function parseClaudeUsagePayload(data: unknown): AccountQuota | null {
  const record = toRecord(data);
  const windows: Record<string, QuotaWindow> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "five_hour" && key !== "seven_day" && !key.startsWith("seven_day_")) continue;
    const utilization = percent(toRecord(value).utilization);
    if (utilization === null) continue;
    windows[key] = { utilization, resetsAt: isoOrNull(toRecord(value).resets_at) };
  }
  if (Array.isArray(record.limits)) {
    for (const raw of record.limits) {
      const entry = toRecord(raw);
      const named = limitWindowName(entry);
      if (!named) continue;
      const utilization = percent(entry.percent);
      if (utilization === null) continue;
      // The legacy key said the same thing about this window; the scope is
      // the one thing the list adds to it.
      if (windows[named.name]) {
        if (named.scope) windows[named.name].scope = named.scope;
        continue;
      }
      windows[named.name] = { utilization, resetsAt: isoOrNull(entry.resets_at), ...(named.scope ? { scope: named.scope } : {}) };
    }
  }
  if (Object.keys(windows).length === 0) return null;
  const plan = [record.tier, record.plan, record.subscription_type].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0 && !/^(claude code|unknown)$/i.test(v.trim()),
  );
  return { windows, plan: plan ?? null, source: "usage-endpoint" };
}

export interface UsageFetchResult {
  quota: AccountQuota | null;
  error: string | null;
}

/** The real CLI uses axios here — a `claude-code/<version>` UA, not the Stainless shape. */
export async function fetchClaudeUsage(accessToken: string): Promise<UsageFetchResult> {
  if (coolingDown(accessToken)) return { quota: null, error: "usage endpoint cooling down" };
  try {
    const res = await fetch(ANTHROPIC_OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429) cooldown.set(accessToken, Date.now() + USAGE_429_COOLDOWN_MS);
      const text = await res.text().catch(() => "");
      return { quota: null, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    const quota = parseClaudeUsagePayload(await res.json().catch(() => null));
    return quota ? { quota, error: null } : { quota: null, error: "usage payload had no windows" };
  } catch (error) {
    return { quota: null, error: error instanceof Error ? error.message : "fetch failed" };
  }
}

/**
 * Refresh one account's snapshot. A failure keeps whatever windows are already
 * known and records why, so the panel can say "stale, and here is the reason"
 * rather than silently showing nothing.
 */
export async function refreshAccountQuota(account: Account): Promise<UsageFetchResult> {
  const existing = inflight.get(account.id);
  if (existing) return existing;

  const run = (async (): Promise<UsageFetchResult> => {
    const creds = await getValidCredentialsFor(account.id);
    if (!creds) return { quota: null, error: "no usable credentials" };

    const result = await fetchClaudeUsage(creds.accessToken);
    try {
      if (result.quota) {
        saveAccountQuota(account.id, result.quota);
      } else {
        // The timestamp is written on failure too: it is the "last tried" mark
        // that keeps a failing account from being re-polled on every page load.
        saveAccountQuota(account.id, {
          windows: account.quota?.windows ?? {},
          plan: account.quota?.plan ?? null,
          source: account.quota?.source ?? "usage-endpoint",
          error: result.error,
        });
      }
    } catch {
      // bookkeeping only
    }
    recordPollOutcome(account.id, !!result.quota);
    return result;
  })().finally(() => {
    inflight.delete(account.id);
  });

  inflight.set(account.id, run);
  return run;
}

/** True when this account has never been polled, or not within the interval. */
export function quotaIsStale(account: Account, refreshMinutes: number, now = Date.now()): boolean {
  if (!account.quotaFetchedAt) return true;
  return now - account.quotaFetchedAt >= refreshMinutes * 60_000;
}

/** Stale, and not inside the backoff a run of failed polls earned. */
export function shouldPollQuota(account: Account, refreshMinutes: number, now = Date.now()): boolean {
  const until = nextAttempt.get(account.id);
  if (until !== undefined && until > now) return false;
  return quotaIsStale(account, refreshMinutes, now);
}

async function refreshAll(accounts: Account[]): Promise<void> {
  await Promise.all(
    accounts.map((a) =>
      refreshAccountQuota(a).catch(() => {
        // best-effort: a poll failure must never fail the caller
      }),
    ),
  );
}

/**
 * Periodic refresh — the startup daemon's job, so the pool's quota floor and
 * the throttle keep working on an idle account. A busy account is skipped for
 * free: the unified headers on its replies already refreshed the same
 * timestamp, so it is never stale when this runs.
 */
export async function refreshStaleQuotas(refreshMinutes: number): Promise<void> {
  await refreshAll(listAccounts().filter((a) => a.enabled && shouldPollQuota(a, refreshMinutes)));
}

/**
 * Opening the dashboard fills in an account that has *never* been polled, and
 * nothing else. Keeping the periodic refresh out of the request path is what
 * stops a page the operator leaves open — or reloads while reordering the pool
 * — from turning into a poll every few minutes on an endpoint Anthropic
 * rate-limits separately.
 */
export async function refreshUnpolledQuotas(): Promise<void> {
  await refreshAll(listAccounts().filter((a) => a.enabled && shouldPollQuota(a, Infinity)));
}
