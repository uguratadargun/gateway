import { getDb, kvGet, kvSet } from "./db";

/**
 * Tracks Anthropic rate-limit state from response headers. Captures every
 * `anthropic-ratelimit-*` header raw, parses the unified 5h/7d window fields
 * when present, keeps a short history, and forecasts time-to-limit.
 */

export interface RateLimitSnapshot {
  updatedAt: number;
  unifiedStatus: string | null; // "allowed" | "allowed_warning" | "rejected"
  /** 0..1 utilization of the rolling 5-hour window, when the API reports it. */
  utilization5h: number | null;
  utilization7d: number | null;
  status5h: string | null;
  status7d: string | null;
  /** Epoch ms when the current window resets. */
  resetAt: number | null;
  retryAfter: number | null;
  raw: Record<string, string>;
}

export interface RateLimitForecast {
  utilization: number | null;
  status: string | null;
  resetAt: number | null;
  /** Estimated ms until utilization reaches 1.0 at the recent pace; null if unknown/flat. */
  etaToLimitMs: number | null;
  level: "ok" | "warning" | "critical";
  updatedAt: number | null;
}

const KEY = "ratelimit";
const HISTORY_KEEP = 2000;

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epochMs(v: string | null | undefined): number | null {
  const n = num(v);
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n; // seconds vs ms
}

function findRaw(raw: Record<string, string>, ...patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = Object.keys(raw).find((k) => p.test(k));
    if (hit) return raw[hit];
  }
  return null;
}

/** Extract a snapshot from upstream response headers and persist it. */
export function recordRateLimit(headers: Headers): void {
  const raw: Record<string, string> = {};
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n.startsWith("anthropic-ratelimit-") || n === "retry-after") raw[n] = value;
  });
  if (Object.keys(raw).length === 0) return;

  const snap: RateLimitSnapshot = {
    updatedAt: Date.now(),
    unifiedStatus: raw["anthropic-ratelimit-unified-status"] ?? null,
    utilization5h: num(findRaw(raw, /unified-5h-utilization$/, /5h.*utilization/)),
    utilization7d: num(findRaw(raw, /unified-7d-utilization$/, /7d.*utilization/)),
    status5h: findRaw(raw, /unified-5h-status$/),
    status7d: findRaw(raw, /unified-7d-status$/),
    resetAt: epochMs(findRaw(raw, /unified-5h-reset$/, /unified-reset$/, /tokens-reset$/, /requests-reset$/)),
    retryAfter: num(raw["retry-after"]),
    raw,
  };

  try {
    kvSet(KEY, JSON.stringify(snap));
    const db = getDb();
    db.prepare("INSERT INTO ratelimit_history (ts, util_5h, util_7d, status, reset_at) VALUES (?,?,?,?,?)").run(
      snap.updatedAt, snap.utilization5h, snap.utilization7d, snap.unifiedStatus, snap.resetAt,
    );
    db.prepare("DELETE FROM ratelimit_history WHERE id NOT IN (SELECT id FROM ratelimit_history ORDER BY ts DESC LIMIT ?)").run(HISTORY_KEEP);
  } catch {
    // best-effort
  }
}

/**
 * Forgets the windows.
 *
 * Rate-limit state belongs to an account, not to gate: kept across a change of
 * account it describes someone else's quota, and the throttle would refuse a
 * fresh account's requests on the strength of an exhausted one. The history
 * goes too — a forecast built from the old account's slope is no better.
 */
export function resetRateLimit(): void {
  try {
    kvSet(KEY, "");
    getDb().prepare("DELETE FROM ratelimit_history").run();
  } catch {
    // best-effort: a stale snapshot expires on its own at the window reset
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

/** Current 5h utilization (0..1) if the API reports it; null otherwise. */
export function currentUtilization(): number | null {
  const s = readRateLimit();
  if (!s) return null;
  // A snapshot older than the window reset is stale.
  if (s.resetAt && Date.now() > s.resetAt) return null;
  return s.utilization5h;
}

export function forecastRateLimit(): RateLimitForecast {
  const s = readRateLimit();
  if (!s) return { utilization: null, status: null, resetAt: null, etaToLimitMs: null, level: "ok", updatedAt: null };

  const stale = !!s.resetAt && Date.now() > s.resetAt;
  const utilization = stale ? null : s.utilization5h;
  const status = stale ? null : s.unifiedStatus;

  let etaToLimitMs: number | null = null;
  if (utilization != null && utilization < 1) {
    try {
      const rows = getDb()
        .prepare("SELECT ts, util_5h FROM ratelimit_history WHERE util_5h IS NOT NULL AND ts >= ? ORDER BY ts ASC")
        .all(Date.now() - 30 * 60_000) as Array<{ ts: number; util_5h: number }>;
      if (rows.length >= 2) {
        // Slope over the latest monotonically rising run only, so a window
        // reset (utilization dropping) doesn't poison the estimate.
        let start = rows.length - 1;
        while (start > 0 && Number(rows[start - 1].util_5h) <= Number(rows[start].util_5h)) start--;
        const first = rows[start];
        const last = rows[rows.length - 1];
        const dt = Number(last.ts) - Number(first.ts);
        const du = Number(last.util_5h) - Number(first.util_5h);
        if (dt > 0 && du > 0) etaToLimitMs = Math.round(((1 - utilization) / du) * dt);
      }
    } catch {
      // ignore
    }
  }

  let level: RateLimitForecast["level"] = "ok";
  if (status === "rejected" || (utilization != null && utilization >= 0.98)) level = "critical";
  else if (status === "allowed_warning" || (utilization != null && utilization >= 0.8)) level = "warning";

  return { utilization, status, resetAt: stale ? null : s.resetAt, etaToLimitMs, level, updatedAt: s.updatedAt };
}
