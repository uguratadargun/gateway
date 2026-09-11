import type { Decision, DecisionHit, Feature, FeatureHit, FeatureImplementation } from "./types";

/**
 * How a run reaches memory, wherever the run is — the shapes, and the text a
 * model or a person reads them as.
 *
 * On the server a node's tool reads the tables directly; on a developer's
 * machine the same tool goes over HTTP with the person's key; in a session,
 * the person's Claude Code runs `gate memory …`. All three go through this
 * one shape, and all three answer as the caller's team — the scope is worked
 * out from the key or the run, never from anything the model says.
 *
 * Nothing here touches the database: the dashboard's client components and
 * the bundled CLI import from this file, and neither can carry SQLite.
 */

export interface MemorySearchRequest {
  query?: string;
  paths?: string[];
  featureId?: string;
  /** Milliseconds since the epoch; only decisions that held then. */
  asOf?: number;
  since?: number;
  limit?: number;
}

/** A decision as a tool hands it to a model: the record, without the bulk. */
export interface DecisionCard {
  id: string;
  team: string;
  featureId: string | null;
  title: string;
  decision: string;
  rationale: string;
  how: string;
  consequences: string;
  alternatives: string;
  touches: string[];
  outcome: Decision["outcome"];
  /** ISO dates: when it started holding, and when it stopped, if it did. */
  validFrom: string;
  validTo: string | null;
  supersedes: string | null;
  executionId: string;
  commits: { base: string | null; head: string | null };
}

export interface FeatureCard {
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  /** Which teams have built it. */
  teams: string[];
}

export interface MemorySearchResult {
  /** The tree searched, so a reader knows whose records these are. */
  scope: { own: string; teams: string[] };
  features: FeatureCard[];
  decisions: DecisionCard[];
}

export interface FeatureDetail {
  feature: FeatureCard;
  implementations: Array<{ team: string; summary: string; pitfalls: string; decisionCount: number; updatedAt: string; consolidatedAt?: string | null }>;
  decisions: DecisionCard[];
  /** The consolidation passes made over it, newest first. Absent over the client API. */
  consolidations?: Array<{ team: string; status: string; at: string; model: string | null; costUsd: number | null; decisionsRead: number; superseded: number; error: string | null }>;
}

export interface MemoryAccess {
  search(req: MemorySearchRequest): Promise<MemorySearchResult>;
  feature(id: string): Promise<FeatureDetail | null>;
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function toDecisionCard(d: Decision | DecisionHit): DecisionCard {
  return {
    id: d.id,
    team: d.teamId,
    featureId: d.featureId,
    title: d.title,
    decision: d.decision,
    rationale: d.rationale,
    how: d.how,
    consequences: d.consequences,
    alternatives: d.alternatives,
    touches: d.touches.map((t) => (t.kind === "area" ? `area:${t.ref}` : t.ref)),
    outcome: d.outcome,
    validFrom: iso(d.validFrom)!,
    validTo: iso(d.validTo),
    supersedes: d.supersedes ?? null,
    executionId: d.executionId,
    commits: { base: d.baseCommit, head: d.headCommit },
  };
}

export function toFeatureCard(f: Feature | FeatureHit, teams?: string[]): FeatureCard {
  return { id: f.id, name: f.name, aliases: f.aliases, summary: f.summary, teams: teams ?? ("teams" in f ? f.teams : []) };
}

export function implementationLine(i: FeatureImplementation) {
  return { team: i.teamId, summary: i.summary, pitfalls: i.pitfalls, decisionCount: i.decisionCount, updatedAt: iso(i.updatedAt)! };
}

// ── What a model reads ───────────────────────────────────────────────────────

const MAX_FIELD = 1_200;

function clip(s: string, max = MAX_FIELD): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A search result as the text a tool hands back: compact, every id present. */
export function describeSearch(result: MemorySearchResult): string {
  const out: string[] = [];
  if (result.features.length) {
    out.push("Features in the catalogue that match:");
    for (const f of result.features) {
      out.push(`- ${f.id} — ${f.name}${f.aliases.length ? ` (also: ${f.aliases.join(", ")})` : ""} · built by: ${f.teams.join(", ") || "nobody yet"}${f.summary ? `\n  ${clip(f.summary, 300)}` : ""}`);
    }
    out.push("");
  }
  if (!result.decisions.length) {
    out.push(result.features.length ? "No decisions matched the text or paths; use memory_feature on a feature above for its decisions." : "Nothing in memory matches. The team has no recorded decision about this.");
    return out.join("\n");
  }
  out.push(`${result.decisions.length} decision${result.decisions.length === 1 ? "" : "s"} (searched teams: ${result.scope.teams.join(", ")}; own team ${result.scope.own} first):`);
  for (const d of result.decisions) out.push(describeDecision(d));
  return out.join("\n");
}

export function describeDecision(d: DecisionCard): string {
  const lines = [
    `\n## ${d.title}`,
    `id: ${d.id} · team: ${d.team} · ${d.outcome} · from ${d.validFrom.slice(0, 10)}${d.validTo ? ` to ${d.validTo.slice(0, 10)} (no longer holds)` : ""}${d.featureId ? ` · feature: ${d.featureId}` : ""}${d.supersedes ? ` · supersedes ${d.supersedes}` : ""}`,
    `run: ${d.executionId}${d.commits.base || d.commits.head ? ` · commits ${d.commits.base ?? "?"}..${d.commits.head ?? "?"}` : ""}`,
  ];
  if (d.decision) lines.push(`decision: ${clip(d.decision)}`);
  if (d.rationale) lines.push(`why: ${clip(d.rationale)}`);
  if (d.how) lines.push(`how: ${clip(d.how, 2_000)}`);
  if (d.alternatives) lines.push(`not taken: ${clip(d.alternatives, 600)}`);
  if (d.consequences) lines.push(`consequences: ${clip(d.consequences)}`);
  if (d.touches.length) lines.push(`touches: ${d.touches.slice(0, 30).join(", ")}${d.touches.length > 30 ? ` (+${d.touches.length - 30})` : ""}`);
  return lines.join("\n");
}

export function describeFeature(detail: FeatureDetail): string {
  const { feature } = detail;
  const out = [
    `# ${feature.name} (${feature.id})`,
    feature.aliases.length ? `also known as: ${feature.aliases.join(", ")}` : "",
    feature.summary,
    "",
  ];
  if (detail.implementations.length) {
    out.push("How each team built it:");
    for (const i of detail.implementations) {
      out.push(`\n### ${i.team} · ${i.decisionCount} decision${i.decisionCount === 1 ? "" : "s"} · updated ${i.updatedAt.slice(0, 10)}`);
      out.push(i.summary || "(no summary yet)");
      if (i.pitfalls) out.push(`pitfalls: ${i.pitfalls}`);
    }
  } else {
    out.push("No team has recorded an implementation of it yet.");
  }
  if (detail.decisions.length) {
    out.push(`\nDecisions (${detail.decisions.length}):`);
    for (const d of detail.decisions) out.push(describeDecision(d));
  }
  return out.filter((l) => l !== "").join("\n");
}
