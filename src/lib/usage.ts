import { getDb } from "./db";
import { costForUsage, tierOf, type TokenUsage } from "./pricing";
import { loadSettings } from "./settings";

function costOfModel(model: string, u: TokenUsage): number {
  return costForUsage(tierOf(model), u, { model, cacheTtl: loadSettings().promptCache.ttl });
}

export interface UsageEvent {
  ts: number;
  requested: string;
  model: string;
  tier: string;
  reason: string;
  status: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  stream: boolean;
  sessionId?: string | null;
  sessionTitle?: string | null;
}

export interface UsageSummary {
  total: number;
  byTier: Record<string, number>;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Share of prompt tokens served from Anthropic's prompt cache (0..1). */
  cacheHitRatio: number;
  /** Est. API-equivalent cost (USD) of the routed traffic. */
  cost: number;
  /** Est. cost had every request run on Opus (USD). */
  costAllOpus: number;
  /** costAllOpus - cost: what routing to cheaper tiers saved. */
  savings: number;
  recent: UsageEvent[];
}

export function recordUsage(e: UsageEvent): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO usage (ts,requested,model,tier,reason,status,stream,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      e.ts, e.requested, e.model, e.tier, e.reason, e.status, e.stream ? 1 : 0,
      e.inputTokens ?? 0, e.outputTokens ?? 0, e.cacheReadTokens ?? 0, e.cacheCreationTokens ?? 0,
      e.sessionId ?? null,
    );
    if (e.sessionId) {
      db.prepare(
        "INSERT INTO sessions (id, title, first_ts, last_ts) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_ts = excluded.last_ts, title = COALESCE(sessions.title, excluded.title)",
      ).run(e.sessionId, e.sessionTitle ?? null, e.ts, e.ts);
    }
  } catch {
    // usage logging is best-effort
  }
}

interface ModelAgg {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  n: number;
}

const AGG_COLS =
  "SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_creation_tokens) AS cache_creation, COUNT(*) AS n";

function usageOf(r: { input: number; output: number; cache_read: number; cache_creation: number }): TokenUsage {
  return {
    input: Number(r.input),
    output: Number(r.output),
    cacheRead: Number(r.cache_read),
    cacheCreation: Number(r.cache_creation),
  };
}

function aggregateByModel(sinceTs: number): ModelAgg[] {
  return getDb()
    .prepare(`SELECT model, ${AGG_COLS} FROM usage WHERE ts >= ? GROUP BY model`)
    .all(sinceTs) as ModelAgg[];
}

function costOf(rows: ModelAgg[]): number {
  return rows.reduce((sum, r) => sum + costOfModel(r.model, usageOf(r)), 0);
}

// ---- Sticky sessions (model + effort held stable for prompt-cache hits) ----

export function getSessionRoute(id: string): { tier: string | null; effort: string | null } | null {
  const row = getDb().prepare("SELECT base_tier, effort FROM sessions WHERE id = ?").get(id);
  if (!row) return null;
  return { tier: row.base_tier ?? null, effort: row.effort ?? null };
}

export function setSessionRoute(id: string, tier: string, effort: string | null): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO sessions (id, title, first_ts, last_ts, base_tier, effort) VALUES (?,NULL,?,?,?,?) ON CONFLICT(id) DO UPDATE SET base_tier = excluded.base_tier, effort = excluded.effort, last_ts = excluded.last_ts",
    )
    .run(id, now, now, tier, effort);
}

/** Total est. cost (USD) spent today and this calendar month. O(models), not O(rows). */
export function getSpend(): { today: number; month: number } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { today: costOf(aggregateByModel(startOfDay)), month: costOf(aggregateByModel(startOfMonth)) };
}

function rowToEvent(r: any): UsageEvent {
  return {
    ts: Number(r.ts),
    requested: r.requested ?? "",
    model: r.model,
    tier: r.tier,
    reason: r.reason ?? "",
    status: Number(r.status),
    stream: !!r.stream,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(r.cache_creation_tokens ?? 0),
    sessionId: r.session_id ?? null,
  };
}

const EVENT_COLS =
  "ts, requested, model, tier, reason, status, stream, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, session_id";

export function readUsage(limit = 50): UsageSummary {
  const db = getDb();
  const byModelRows = aggregateByModel(0);
  const byTierRows = db.prepare("SELECT tier, COUNT(*) AS n FROM usage GROUP BY tier").all() as Array<{ tier: string; n: number }>;

  const summary: UsageSummary = {
    total: 0,
    byTier: {},
    byModel: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRatio: 0,
    cost: 0,
    costAllOpus: 0,
    savings: 0,
    recent: [],
  };
  for (const r of byModelRows) {
    const u = usageOf(r);
    summary.total += Number(r.n);
    summary.byModel[r.model] = Number(r.n);
    summary.inputTokens += u.input;
    summary.outputTokens += u.output;
    summary.cacheReadTokens += u.cacheRead ?? 0;
    summary.cacheCreationTokens += u.cacheCreation ?? 0;
    summary.cost += costOfModel(r.model, u);
    summary.costAllOpus += costForUsage("opus", u, { cacheTtl: loadSettings().promptCache.ttl });
  }
  summary.savings = summary.costAllOpus - summary.cost;
  const promptTotal = summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens;
  summary.cacheHitRatio = promptTotal > 0 ? summary.cacheReadTokens / promptTotal : 0;
  for (const r of byTierRows) summary.byTier[r.tier] = Number(r.n);

  summary.recent = (db.prepare(`SELECT ${EVENT_COLS} FROM usage ORDER BY ts DESC LIMIT ?`).all(limit) as any[]).map(rowToEvent);
  return summary;
}

// ---- Sessions --------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title: string | null;
  firstTs: number;
  lastTs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  models: string[];
}

export function listSessions(limit = 50): SessionSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT session_id, model, ${AGG_COLS}, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM usage WHERE session_id IS NOT NULL GROUP BY session_id, model`,
    )
    .all() as Array<ModelAgg & { session_id: string; first_ts: number; last_ts: number }>;
  const titles = new Map<string, string | null>(
    (db.prepare("SELECT id, title FROM sessions").all() as Array<{ id: string; title: string | null }>).map((s) => [s.id, s.title]),
  );
  const map = new Map<string, SessionSummary>();
  for (const r of rows) {
    const u = usageOf(r);
    const s = map.get(r.session_id) ?? {
      id: r.session_id,
      title: titles.get(r.session_id) ?? null,
      firstTs: Number(r.first_ts),
      lastTs: Number(r.last_ts),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      models: [],
    };
    s.firstTs = Math.min(s.firstTs, Number(r.first_ts));
    s.lastTs = Math.max(s.lastTs, Number(r.last_ts));
    s.requests += Number(r.n);
    s.inputTokens += u.input;
    s.outputTokens += u.output;
    s.cacheReadTokens += u.cacheRead ?? 0;
    s.cost += costOfModel(r.model, u);
    if (!s.models.includes(r.model)) s.models.push(r.model);
    map.set(r.session_id, s);
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
}

export function getSession(id: string): { summary: SessionSummary | null; events: UsageEvent[] } {
  const summary = listSessions(10_000).find((s) => s.id === id) ?? null;
  const events = (
    getDb().prepare(`SELECT ${EVENT_COLS} FROM usage WHERE session_id = ? ORDER BY ts DESC LIMIT 200`).all(id) as any[]
  ).map(rowToEvent);
  return { summary, events };
}

// ---- Analytics (time series) ---------------------------------------------

export type AnalyticsRange = "24h" | "7d" | "30d";

export interface AnalyticsBucket {
  ts: number;
  requests: number;
  tokens: number;
  cost: number;
  byTier: Record<string, { requests: number; tokens: number; cost: number }>;
}

export interface Analytics {
  range: AnalyticsRange;
  bucketMs: number;
  buckets: AnalyticsBucket[];
  byModel: Array<{ model: string; requests: number; tokens: number; cost: number }>;
  totals: { requests: number; tokens: number; cost: number; cacheHitRatio: number };
}

export function getAnalytics(range: AnalyticsRange): Analytics {
  const now = Date.now();
  const spanMs = range === "24h" ? 24 * 3600_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  const bucketMs = range === "24h" ? 3600_000 : 86_400_000;
  const since = Math.floor((now - spanMs) / bucketMs) * bucketMs;

  // node:sqlite binds JS numbers as REAL, so `ts / ?` would be real division;
  // CAST forces the floor so rows align to bucket boundaries.
  const rows = getDb()
    .prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, tier, model, ${AGG_COLS} FROM usage WHERE ts >= ? GROUP BY bucket, tier, model`,
    )
    .all(bucketMs, bucketMs, since) as Array<ModelAgg & { bucket: number; tier: string }>;

  const buckets = new Map<number, AnalyticsBucket>();
  for (let t = since; t <= now; t += bucketMs) {
    buckets.set(t, { ts: t, requests: 0, tokens: 0, cost: 0, byTier: {} });
  }
  const byModel = new Map<string, { model: string; requests: number; tokens: number; cost: number }>();
  const totals = { requests: 0, tokens: 0, cost: 0, cacheHitRatio: 0 };
  let promptTotal = 0;
  let cacheRead = 0;

  for (const r of rows) {
    const u = usageOf(r);
    const tokens = u.input + u.output + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0);
    const cost = costOfModel(r.model, u);
    const b = buckets.get(Number(r.bucket)) ?? { ts: Number(r.bucket), requests: 0, tokens: 0, cost: 0, byTier: {} };
    b.requests += Number(r.n);
    b.tokens += tokens;
    b.cost += cost;
    const bt = b.byTier[r.tier] ?? { requests: 0, tokens: 0, cost: 0 };
    bt.requests += Number(r.n);
    bt.tokens += tokens;
    bt.cost += cost;
    b.byTier[r.tier] = bt;
    buckets.set(b.ts, b);

    const m = byModel.get(r.model) ?? { model: r.model, requests: 0, tokens: 0, cost: 0 };
    m.requests += Number(r.n);
    m.tokens += tokens;
    m.cost += cost;
    byModel.set(r.model, m);

    totals.requests += Number(r.n);
    totals.tokens += tokens;
    totals.cost += cost;
    promptTotal += u.input + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0);
    cacheRead += u.cacheRead ?? 0;
  }
  totals.cacheHitRatio = promptTotal > 0 ? cacheRead / promptTotal : 0;

  return {
    range,
    bucketMs,
    buckets: [...buckets.values()].sort((a, b) => a.ts - b.ts),
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
    totals,
  };
}

// ---- Export ----------------------------------------------------------------

export function exportUsage(limit = 10_000): Record<string, unknown>[] {
  return (getDb().prepare(`SELECT ${EVENT_COLS} FROM usage ORDER BY ts DESC LIMIT ?`).all(limit) as any[]).map(
    (r) => ({ ...rowToEvent(r), iso: new Date(Number(r.ts)).toISOString() }),
  );
}
