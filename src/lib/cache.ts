import { createHash } from "node:crypto";

import { getDb, kvGet, kvSet } from "./db";
import { loadSettings } from "./settings";

/**
 * Response cache for identical non-streaming requests, so retries and
 * idempotent tool calls don't burn quota. Callers gate on temperature (only
 * deterministic requests are cacheable) — see gateway-core.
 */

interface CacheEntry {
  body: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  storedAt: number;
}

const MAX_ENTRIES = 500;

function bump(counter: "cache_hits" | "cache_misses"): void {
  kvSet(counter, String(Number(kvGet(counter) ?? 0) + 1));
}

export function cacheKey(model: string, body: Record<string, unknown>): string {
  const material = JSON.stringify({
    model,
    system: body.system ?? null,
    messages: body.messages ?? null,
    tools: body.tools ?? null,
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}

export function cacheGet(key: string): CacheEntry | null {
  const cfg = loadSettings().cache;
  if (!cfg.enabled) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT body, model, input_tokens, output_tokens, stored_at FROM cache WHERE key = ?")
    .get(key);
  if (!row) {
    bump("cache_misses");
    return null;
  }
  if (Date.now() - Number(row.stored_at) > cfg.ttlSeconds * 1000) {
    db.prepare("DELETE FROM cache WHERE key = ?").run(key);
    bump("cache_misses");
    return null;
  }
  bump("cache_hits");
  return {
    body: row.body,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    storedAt: Number(row.stored_at),
  };
}

export function cacheSet(key: string, entry: Omit<CacheEntry, "storedAt">): void {
  if (!loadSettings().cache.enabled) return;
  const db = getDb();
  db.prepare(
    "INSERT INTO cache (key, body, model, input_tokens, output_tokens, stored_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, model=excluded.model, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, stored_at=excluded.stored_at",
  ).run(key, entry.body, entry.model, entry.inputTokens, entry.outputTokens, Date.now());
  db.prepare(
    "DELETE FROM cache WHERE key NOT IN (SELECT key FROM cache ORDER BY stored_at DESC LIMIT ?)",
  ).run(MAX_ENTRIES);
}

export function cacheStats(): { hits: number; misses: number; entries: number; hitRate: number } {
  const hits = Number(kvGet("cache_hits") ?? 0);
  const misses = Number(kvGet("cache_misses") ?? 0);
  const entries = Number(getDb().prepare("SELECT COUNT(*) AS n FROM cache").get().n);
  const total = hits + misses;
  return { hits, misses, entries, hitRate: total > 0 ? hits / total : 0 };
}

export function cacheClear(): void {
  getDb().exec("DELETE FROM cache");
  kvSet("cache_hits", "0");
  kvSet("cache_misses", "0");
}
