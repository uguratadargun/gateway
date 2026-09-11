import { configuredEmbedder, decisionText, featureText, fuseRanks, nearest, storeEmbedding, unembeddedIds, type Embedder } from "./embeddings";
import { getDecision, getFeature, searchDecisions, searchFeatures } from "./store";
import type { DecisionHit, DecisionSearch, FeatureHit, MemoryScope } from "./types";

/**
 * Words and vectors, fused.
 *
 * Full-text search ranks what shares the query's words; the vector search
 * ranks what shares its meaning. Each list is good where the other is not —
 * a file path is a word, "alerts" for "notifications" is a meaning — so
 * both run and reciprocal rank fusion orders the union. Without an embedder
 * this is the full-text search, unchanged, so nothing above needs to know
 * which it got.
 *
 * The scope is applied before any vector is compared: the candidates come
 * from SQL with the team filter in it, and the vector search only orders
 * those. A vector never widens what a team may read.
 */

function ownFirst<T extends { teamId: string; score: number }>(scope: MemoryScope, hits: T[]): T[] {
  return hits.map((h) => ({ ...h, score: h.teamId === scope.own ? h.score * 1.15 : h.score })).sort((a, b) => b.score - a.score);
}

export async function hybridSearchDecisions(scope: MemoryScope, search: DecisionSearch, embedder: Embedder | null = configuredEmbedder()): Promise<DecisionHit[]> {
  const limit = Math.min(Math.max(search.limit ?? 20, 1), 200);
  const words = searchDecisions(scope, { ...search, limit: Math.max(limit * 3, 30) });
  if (!embedder || !search.query?.trim()) return words.slice(0, limit);

  let query: Float32Array;
  try {
    [query] = await embedder.embed([search.query]);
  } catch {
    // The provider is down or slow: the words still answer.
    return words.slice(0, limit);
  }
  // Everything the non-text filters allow, in scope — the set a vector may rank.
  const candidates = searchDecisions(scope, { ...search, query: undefined, limit: 5_000 });
  const allowed = new Set(candidates.map((d) => d.id));
  const vectors = nearest("decision", embedder.model, query, allowed, Math.max(limit * 3, 30));
  const fused = fuseRanks([words.map((d) => d.id), vectors.map((v) => v.id)]);
  const byId = new Map(words.map((d) => [d.id, d]));
  const hits: DecisionHit[] = [];
  for (const f of fused) {
    const d = byId.get(f.id) ?? getDecision(f.id);
    if (d) hits.push({ ...d, score: f.score });
    if (hits.length >= limit * 2) break;
  }
  return ownFirst(scope, hits).slice(0, limit);
}

export async function hybridSearchFeatures(scope: MemoryScope, text: string, limit = 10, embedder: Embedder | null = configuredEmbedder()): Promise<FeatureHit[]> {
  const words = searchFeatures(scope, text, Math.max(limit * 3, 20));
  if (!embedder || !text.trim()) return words.slice(0, limit);
  let query: Float32Array;
  try {
    [query] = await embedder.embed([text]);
  } catch {
    return words.slice(0, limit);
  }
  // The whole catalogue of the tree is the candidate set; it is small.
  const { listFeatures } = await import("./store");
  const all = listFeatures(scope, 10_000);
  const allowed = new Set(all.map((f) => f.id));
  const teamsOf = new Map(all.map((f) => [f.id, f.teams]));
  const vectors = nearest("feature", embedder.model, query, allowed, Math.max(limit * 3, 20));
  const fused = fuseRanks([words.map((f) => f.id), vectors.map((v) => v.id)]);
  const byId = new Map(words.map((f) => [f.id, f]));
  const hits: FeatureHit[] = [];
  for (const f of fused) {
    const feature = byId.get(f.id) ?? (getFeature(f.id) && { ...getFeature(f.id)!, score: 0, teams: teamsOf.get(f.id) ?? [] });
    if (feature) hits.push({ ...feature, score: f.score });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Embeds what has no vector yet for the model in use — new decisions and
 * features after a recording, everything after the provider was first set.
 * Bounded per call; the drain asks again next time.
 */
export async function embedMissing(embedder: Embedder | null = configuredEmbedder(), perKind = 200): Promise<number> {
  if (!embedder) return 0;
  let done = 0;
  const features = unembeddedIds("feature", embedder.model, perKind).map((id) => getFeature(id)).filter((f): f is NonNullable<typeof f> => !!f);
  if (features.length) {
    const vectors = await embedder.embed(features.map(featureText));
    features.forEach((f, i) => storeEmbedding("feature", f.id, embedder.model, vectors[i]));
    done += features.length;
  }
  const decisions = unembeddedIds("decision", embedder.model, perKind).map((id) => getDecision(id)).filter((d): d is NonNullable<typeof d> => !!d);
  if (decisions.length) {
    const vectors = await embedder.embed(decisions.map(decisionText));
    decisions.forEach((d, i) => storeEmbedding("decision", d.id, embedder.model, vectors[i]));
    done += decisions.length;
  }
  return done;
}
