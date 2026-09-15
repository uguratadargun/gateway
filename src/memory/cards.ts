import type { DecisionIssue } from "./issues";
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
  /**
   * The repository the question is about. Never asked of a model: a run
   * already works in exactly one repository and the access object carries it
   * — see LocalMemoryAccess. This is for callers outside a run, which say so
   * for themselves.
   */
  repoId?: string | null;
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

/**
 * An objection standing against a decision, as a tool hands it to a model.
 *
 * A decision card says what a team settled on. This says that somebody else
 * cannot live with it — and it travels with the decision, because the whole
 * failure it exists to fix was a team reading a decision of its own and never
 * learning another team had already found it unworkable.
 */
export interface IssueCard {
  id: string;
  /**
   * "open": a person read this objection and confirmed it. "proposed": a run
   * raised it and nobody has answered yet. The difference is who is asking —
   * a colleague, or a model — and it is never collapsed.
   */
  status: "proposed" | "open";
  /** The team that raised it, and the team whose decision it is against. */
  from: string;
  target: string;
  decisionId: string | null;
  featureId: string | null;
  title: string;
  /** Their decision as the objecting run read it, kept verbatim. */
  theirDecision: string;
  why: string;
  proposal: string;
  /** What the objecting team is asking the other team to change. */
  revision: string;
  paths: string[];
  raisedAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  /** The tree searched, so a reader knows whose records these are. */
  scope: { own: string; teams: string[] };
  features: FeatureCard[];
  decisions: DecisionCard[];
  /** Objections still standing, either against these teams or raised by them. */
  issues: IssueCard[];
  /**
   * Answers this scope's runs took whose objection never reached the server.
   * Not a number to act on — a reason not to read an empty list as agreement.
   */
  heldAnswers: number;
}

export interface FeatureDetail {
  /** The team asking, so an objection can be told as "against us" or "by us". */
  own: string;
  feature: FeatureCard;
  implementations: Array<{ team: string; summary: string; pitfalls: string; decisionCount: number; updatedAt: string; consolidatedAt?: string | null }>;
  decisions: DecisionCard[];
  /** Objections standing against this feature's decisions, from any team in the tree. */
  issues: IssueCard[];
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

export function toIssueCard(i: DecisionIssue): IssueCard {
  return {
    id: i.id,
    status: i.status === "open" ? "open" : "proposed",
    from: i.fromTeamId,
    target: i.targetTeamId,
    decisionId: i.decisionId,
    featureId: i.featureId,
    title: i.title,
    theirDecision: i.decisionSnapshot,
    why: i.rationale,
    proposal: i.proposal,
    revision: i.revision,
    paths: i.paths,
    raisedAt: iso(i.createdAt)!,
    updatedAt: iso(i.updatedAt)!,
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
  } else {
    out.push(`${result.decisions.length} decision${result.decisions.length === 1 ? "" : "s"} (searched teams: ${result.scope.teams.join(", ")}; own team ${result.scope.own} first):`);
    for (const d of result.decisions) out.push(describeDecision(d));
  }
  // Last, and never folded into the decisions above: a decision that another
  // team has objected to is not simply a decision, and a reader who stops
  // early must not stop before this.
  out.push(describeIssues(result.issues, result.scope.own, result.heldAnswers));
  return out.filter(Boolean).join("\n");
}

/**
 * Objections as a block a model cannot read past.
 *
 * The wording does the work the schema cannot: an objection is a request, so
 * it is written as one, and the reader is told which side it is on — being
 * objected to means revising, raising one means waiting for an answer.
 */
export function describeIssues(issues: IssueCard[], own: string, heldAnswers = 0): string {
  const lines: string[] = [];
  if (issues.length) {
    const against = issues.filter((i) => i.target === own);
    lines.push(`\n⚠ ${issues.length} open cross-team objection${issues.length === 1 ? "" : "s"}${against.length ? ` — ${against.length} against this team's own decisions` : ""}.`);
    for (const i of issues) {
      const side = i.target === own ? `${i.from} objects to our decision` : `we objected to ${i.target}`;
      lines.push(`\n### ${i.title}`);
      lines.push(
        `id: ${i.id} · ${side} · ${i.status === "open" ? "confirmed by a person" : "raised, nobody has answered yet"} · raised ${i.raisedAt.slice(0, 10)}${i.decisionId ? ` · about decision ${i.decisionId}` : ""}${i.featureId ? ` · feature: ${i.featureId}` : ""}`,
      );
      if (i.theirDecision) lines.push(`the decision objected to: ${clip(i.theirDecision, 600)}`);
      if (i.why) lines.push(`why it does not work: ${clip(i.why, 800)}`);
      if (i.proposal) lines.push(`proposed instead: ${clip(i.proposal, 800)}`);
      if (i.revision) lines.push(`asked of ${i.target}: ${clip(i.revision, 800)}`);
      if (i.paths.length) lines.push(`touches: ${i.paths.slice(0, 20).join(", ")}`);
    }
    if (against.length) {
      lines.push(
        `\nAn objection against this team's own decision is a revision request, not a note: plan for it, or say in the plan why the objection does not hold. It does not make the decision invalid — only the team that made it can do that.`,
      );
    }
  }
  if (heldAnswers) {
    // Read as agreement, this is the worst failure the feature has: someone
    // answered and the answer went nowhere visible.
    lines.push(
      `\nNote: ${heldAnswers} answer${heldAnswers === 1 ? " was" : "s were"} recorded for objection${heldAnswers === 1 ? "" : "s"} whose own step never reached the server, so ${heldAnswers === 1 ? "it is" : "they are"} not shown above. An empty list is not proof nobody objected.`,
    );
  }
  return lines.join("\n");
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
  if (detail.issues.length) out.push(describeIssues(detail.issues, detail.own));
  return out.filter((l) => l !== "").join("\n");
}
