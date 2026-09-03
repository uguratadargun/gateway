import { kvGet, kvSet } from "./db";

/**
 * Tracks the latest Anthropic rate-limit state, read from response headers so
 * the dashboard can show remaining quota and reset windows and warn before a
 * limit is hit.
 */

export interface RateLimitSnapshot {
  updatedAt: number;
  unifiedStatus: string | null; // "allowed" | "allowed_warning" | "rejected"
  requestsRemaining: number | null;
  requestsLimit: number | null;
  tokensRemaining: number | null;
  tokensLimit: number | null;
  inputTokensRemaining: number | null;
  outputTokensRemaining: number | null;
  resetsAt: string | null;
  retryAfter: number | null;
}

const KEY = "ratelimit";

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract a snapshot from upstream response headers and persist it. */
export function recordRateLimit(headers: Headers): void {
  const snap: RateLimitSnapshot = {
    updatedAt: Date.now(),
    unifiedStatus: headers.get("anthropic-ratelimit-unified-status"),
    requestsRemaining: num(headers.get("anthropic-ratelimit-requests-remaining")),
    requestsLimit: num(headers.get("anthropic-ratelimit-requests-limit")),
    tokensRemaining: num(headers.get("anthropic-ratelimit-tokens-remaining")),
    tokensLimit: num(headers.get("anthropic-ratelimit-tokens-limit")),
    inputTokensRemaining: num(headers.get("anthropic-ratelimit-input-tokens-remaining")),
    outputTokensRemaining: num(headers.get("anthropic-ratelimit-output-tokens-remaining")),
    resetsAt:
      headers.get("anthropic-ratelimit-unified-reset") ??
      headers.get("anthropic-ratelimit-tokens-reset") ??
      headers.get("anthropic-ratelimit-requests-reset"),
    retryAfter: num(headers.get("retry-after")),
  };
  const meaningful =
    snap.unifiedStatus ||
    snap.requestsRemaining != null ||
    snap.tokensRemaining != null ||
    snap.retryAfter != null;
  if (!meaningful) return;
  try {
    kvSet(KEY, JSON.stringify(snap));
  } catch {
    // best-effort
  }
}

export function readRateLimit(): RateLimitSnapshot | null {
  try {
    const raw = kvGet(KEY);
    return raw ? (JSON.parse(raw) as RateLimitSnapshot) : null;
  } catch {
    return null;
  }
}
