import { getDb } from "@/lib/db";
import { getProviderByName, providerApiKey, type Provider } from "@/lib/providers";
import { loadSettings } from "@/lib/settings";

/**
 * Vectors beside the words.
 *
 * Full-text search finds "notifications" from "notify" and misses "alerts";
 * an embedding finds both. gate has no embedding model of its own — Claude
 * serves none — so this reads one from a configured OpenAI-compatible
 * provider (`memory.embeddings.provider`, an Ollama or vLLM or OpenAI
 * endpoint that answers POST /embeddings), and is simply off when none is
 * named: every search then is what it was, words alone.
 *
 * Vectors are stored in the same database as Float32 blobs and compared by
 * cosine in this process, over the candidates a scope allows. Tens of
 * thousands of short vectors compare in tens of milliseconds; the day that
 * is not enough is the day for an index, and nothing above this file would
 * know.
 */

export type EmbeddingKind = "feature" | "decision";

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** What the settings name, or null when embeddings are off. */
export function configuredEmbedder(): Embedder | null {
  const cfg = loadSettings().memory.embeddings;
  if (!cfg.provider || !cfg.model) return null;
  const provider = getProviderByName(cfg.provider);
  if (!provider || !provider.enabled) return null;
  return new OpenAIEmbedder(provider, cfg.model);
}

const TIMEOUT_MS = 60_000;
const MAX_BATCH = 64;

/** POST {baseUrl}/embeddings, the OpenAI shape every compatible server speaks. */
export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly provider: Provider,
    readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, 8_000));
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = providerApiKey(this.provider.id);
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await fetch(`${this.provider.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`embeddings: ${this.provider.label} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const json = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== batch.length) throw new Error(`embeddings: asked for ${batch.length} vectors, got ${rows.length}`);
      for (const r of rows) out.push(normalise(Float32Array.from(r.embedding ?? [])));
    }
    return out;
  }
}

function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function storeEmbedding(kind: EmbeddingKind, id: string, model: string, vector: Float32Array, at = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO memory_embeddings (kind, id, model, dims, vector, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(kind, id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at`,
    )
    .run(kind, id, model, vector.length, toBlob(vector), at);
  cache.delete(kind);
}

export function deleteEmbedding(kind: EmbeddingKind, id: string): void {
  getDb().prepare("DELETE FROM memory_embeddings WHERE kind = ? AND id = ?").run(kind, id);
  cache.delete(kind);
}

/** Ids of this kind that have no vector for the model in use, or an older model's. */
export function unembeddedIds(kind: EmbeddingKind, model: string, limit = 200): string[] {
  const table = kind === "feature" ? "memory_features" : "memory_decisions";
  const rows = getDb()
    .prepare(
      `SELECT b.id FROM ${table} b
        WHERE NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.kind = ? AND e.id = b.id AND e.model = ?)
        ${kind === "decision" ? "AND b.retracted_at IS NULL" : ""}
        LIMIT ?`,
    )
    .all(kind, model, limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** In-process copy of one kind's vectors; dropped on any write to that kind. */
const cache = new Map<EmbeddingKind, { model: string; rows: Array<{ id: string; vector: Float32Array }> }>();

function vectorsOf(kind: EmbeddingKind, model: string): Array<{ id: string; vector: Float32Array }> {
  const hit = cache.get(kind);
  if (hit && hit.model === model) return hit.rows;
  const rows = (getDb().prepare("SELECT id, vector FROM memory_embeddings WHERE kind = ? AND model = ?").all(kind, model) as Array<{ id: string; vector: Uint8Array }>).map(
    (r) => ({ id: r.id, vector: fromBlob(r.vector) }),
  );
  cache.set(kind, { model, rows });
  return rows;
}

/**
 * The nearest stored vectors to `query`, among `allowed` ids, best first.
 * Brute force over the kind's vectors: the scope filter is applied here, on
 * ids the SQL already chose, so a vector never crosses a team boundary.
 */
export function nearest(kind: EmbeddingKind, model: string, query: Float32Array, allowed: Set<string>, limit: number): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const row of vectorsOf(kind, model)) {
    if (!allowed.has(row.id)) continue;
    scored.push({ id: row.id, score: dot(query, row.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** The text a feature or a decision is embedded as. */
export function featureText(f: { name: string; aliases: string[]; summary: string }): string {
  return [f.name, f.aliases.join(", "), f.summary].filter(Boolean).join("\n");
}

export function decisionText(d: { title: string; context: string; decision: string; how: string; touches: Array<{ ref: string }> }): string {
  return [d.title, d.context, d.decision, d.how, d.touches.map((t) => t.ref).join(" ")].filter(Boolean).join("\n");
}

/**
 * Reciprocal rank fusion: two rankings of ids into one, each hit scored by
 * where it stood in each list. k=60 is the usual constant; a hit near the
 * top of both lists beats one at the top of either.
 */
export function fuseRanks(lists: string[][], k = 60): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}
