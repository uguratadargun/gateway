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
  /** Whose record it is: the team whose repository the work was in. */
  team: string;
  /** The team whose run made it, when that is another team; absent from older servers. */
  author?: string | null;
  /** `host/owner/name` of the repository its paths are in; absent from older servers. */
  repo?: string | null;
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
  /**
   * "rejected" when the approach itself was refused — a road found closed.
   * Null when nobody refused it, whatever the run's outcome; an unfinished
   * run is not a verdict. Absent from older servers.
   */
  verdict?: "rejected" | null;
  verdictReason?: string | null;
  /**
   * The record index checked its file touches against the base branch: how
   * many were gone at which commit, and whether that was all of them.
   */
  checked?: { commit: string; missing: number; allGone: boolean } | null;
}

/** A document of a repository's own record, as the record index read it from the base branch. */
export interface DocumentCard {
  /** The connected repository's id, and its `host/owner/name`. */
  repo: string;
  repoId: string | null;
  team: string | null;
  path: string;
  kind: "design" | "decision" | "spec" | "architecture";
  title: string;
  /** A decision record's Status line, a spec's Status. */
  status: string | null;
  date: string | null;
  summary: string;
  /** The base-branch commit it was read at. */
  commit: string;
  interfaces?: InterfaceCard[];
}

/** One line of a design doc's Interfaces section: what a feature offers or uses. */
export interface InterfaceCard {
  name: string;
  role: "provides" | "consumes";
  note: string;
  repo: string;
  repoId: string | null;
  team: string | null;
  path: string;
  /** The design doc's slug, which is its feature's id. */
  feature: string;
}

/** A run going right now somewhere in the tree. */
export interface ActivityCard {
  executionId: string;
  team: string;
  workflow: string;
  task: string;
  repo: string | null;
  branch: string | null;
  person: string | null;
  status: "running" | "paused";
  startedAt: string;
  taskId: string | null;
  /** The words it shares with what was asked, when something was. */
  shared: string[];
}

export interface MemoryHistoryRequest {
  /** Path prefixes; none means the whole repository. */
  paths?: string[];
  since?: number;
  /** For callers outside a run; a run's own repository is carried by the access object. */
  repoId?: string | null;
  limit?: number;
}

export interface HistoryCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  /** The record the commit names on its `Documents:` line. */
  documents: string[];
  /** Gate runs whose work this commit is, when one is known (an id or its first eight characters). */
  runs: string[];
}

export interface HistoryResult {
  /** The repository read, and the base-branch commit the read is of. */
  repo: string | null;
  repoId: string | null;
  ref: string | null;
  commit: string | null;
  commits: HistoryCommit[];
  /** Why there is no history, when there is none to give. */
  unavailable: string | null;
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
  /** The repositories' own documents that match, read from their base branches. Absent from older servers. */
  documents?: DocumentCard[];
  /** Interfaces the words name, with who provides and who consumes each. Absent from older servers. */
  interfaces?: InterfaceCard[];
  /** Runs of the tree going right now on work with the same words. Absent from older servers. */
  inFlight?: ActivityCard[];
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
  /** Every repository's design doc for this feature, as its base branch has it. Absent from older servers. */
  documents?: DocumentCard[];
  /** The consolidation passes made over it, newest first. Absent over the client API. */
  consolidations?: Array<{ team: string; status: string; at: string; model: string | null; costUsd: number | null; decisionsRead: number; superseded: number; error: string | null }>;
}

export interface MemoryAccess {
  search(req: MemorySearchRequest): Promise<MemorySearchResult>;
  feature(id: string): Promise<FeatureDetail | null>;
  /** A repository's base-branch history under some paths, each commit with its record and its run. */
  history(req: MemoryHistoryRequest): Promise<HistoryResult>;
  /** Every run of the tree going right now. */
  activity(): Promise<ActivityCard[]>;
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function toDecisionCard(d: Decision | DecisionHit): DecisionCard {
  const files = d.touches.filter((t) => t.kind === "file").length;
  return {
    id: d.id,
    team: d.teamId,
    author: d.authorTeamId,
    repo: d.repoId,
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
    verdict: d.verdict,
    verdictReason: d.verdictReason,
    checked: d.checkedCommit ? { commit: d.checkedCommit, missing: d.missingTouches, allGone: files > 0 && d.missingTouches >= files } : null,
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
  // First: somebody in the tree may be building this right now, and every
  // other line here is about work that has already ended.
  if (result.inFlight?.length) out.push(describeActivity(result.inFlight, "Running right now elsewhere in the tree, on work with the same words:"), "");
  if (result.features.length) {
    out.push("Features in the catalogue that match:");
    for (const f of result.features) {
      out.push(`- ${f.id} — ${f.name}${f.aliases.length ? ` (also: ${f.aliases.join(", ")})` : ""} · built by: ${f.teams.join(", ") || "nobody yet"}${f.summary ? `\n  ${clip(f.summary, 300)}` : ""}`);
    }
    out.push("");
  }
  if (result.documents?.length) {
    out.push("The repositories' own record — documents on their base branches that match:");
    for (const d of result.documents) out.push(describeDocument(d));
    out.push("");
  }
  if (result.interfaces?.length) {
    out.push(describeInterfaces(result.interfaces), "");
  }
  if (!result.decisions.length) {
    const anything = result.features.length || result.documents?.length || result.inFlight?.length;
    out.push(anything ? "No recorded decisions matched the text or paths; use memory_feature on a feature above for its decisions." : "Nothing in memory matches. The team has no recorded decision about this.");
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

/** The outcome as a reader has to take it: "abandoned" alone reads as a verdict, and is not one. */
function outcomeLabel(d: DecisionCard): string {
  if (d.verdict === "rejected") return `${d.outcome} · refused`;
  if (d.outcome === "abandoned") return "abandoned (the run did not finish — not a refusal)";
  return d.outcome;
}

export function describeDecision(d: DecisionCard): string {
  const who = d.author && d.author !== d.team ? `team: ${d.team} (made by ${d.author})` : `team: ${d.team}`;
  const lines = [
    `\n## ${d.title}`,
    `id: ${d.id} · ${who}${d.repo ? ` · repo: ${d.repo}` : ""} · ${outcomeLabel(d)} · from ${d.validFrom.slice(0, 10)}${d.validTo ? ` to ${d.validTo.slice(0, 10)} (no longer holds)` : ""}${d.featureId ? ` · feature: ${d.featureId}` : ""}${d.supersedes ? ` · supersedes ${d.supersedes}` : ""}`,
    `run: ${d.executionId}${d.commits.base || d.commits.head ? ` · commits ${d.commits.base ?? "?"}..${d.commits.head ?? "?"}` : ""}`,
  ];
  if (d.verdict === "rejected") {
    lines.push(`✗ refused${d.verdictReason ? `: ${clip(d.verdictReason, 600)}` : ""} — a road already found closed; taking it again needs a reason the refusal did not have.`);
  }
  if (d.checked?.allGone) {
    lines.push(`⚠ every file it touched is gone from the base branch at ${d.checked.commit.slice(0, 8)} — it describes code that no longer exists; check the code before relying on it.`);
  }
  // The outcome word alone is a label in a line of labels, and this is the
  // one that changes what the reader should do. A choice still moving is the
  // moment an objection is cheap for everybody; after it sets it is a
  // revision request against shipped work.
  if (d.outcome === "in-progress") {
    lines.push(
      `⚠ work in progress: the team that taught this says it is not finished. Build on it only if you mean to, and raise an objection now rather than after it settles.`,
    );
  }
  if (d.decision) lines.push(`decision: ${clip(d.decision)}`);
  if (d.rationale) lines.push(`why: ${clip(d.rationale)}`);
  if (d.how) lines.push(`how: ${clip(d.how, 2_000)}`);
  if (d.alternatives) lines.push(`not taken: ${clip(d.alternatives, 600)}`);
  if (d.consequences) lines.push(`consequences: ${clip(d.consequences)}`);
  if (d.touches.length) lines.push(`touches: ${d.touches.slice(0, 30).join(", ")}${d.touches.length > 30 ? ` (+${d.touches.length - 30})` : ""}`);
  return lines.join("\n");
}

export function describeDocument(d: DocumentCard): string {
  const kind = d.kind === "decision" ? "decision record" : d.kind === "design" ? "design doc" : d.kind;
  const lines = [
    `- ${kind} ${d.path} — ${d.title}`,
    `  repo: ${d.repoId ?? d.repo}${d.team ? ` · team: ${d.team}` : ""}${d.status ? ` · ${d.status}` : ""}${d.date ? ` · ${d.date}` : ""} · at ${d.commit.slice(0, 8)}`,
  ];
  if (d.summary) lines.push(`  ${clip(d.summary.replace(/\s+/g, " "), 500)}`);
  for (const i of d.interfaces ?? []) lines.push(`  ${i.role} ${i.name}${i.note ? ` — ${clip(i.note, 200)}` : ""}`);
  return lines.join("\n");
}

/** Interfaces grouped by name: who offers it, who uses it, and where each says so. */
export function describeInterfaces(list: InterfaceCard[]): string {
  const byName = new Map<string, InterfaceCard[]>();
  for (const i of list) byName.set(i.name, [...(byName.get(i.name) ?? []), i]);
  const out = ["Interfaces between repositories that this names:"];
  for (const [name, users] of byName) {
    out.push(`- ${name}`);
    for (const u of users) {
      out.push(`  ${u.role} · ${u.team ?? "no team"} · ${u.repoId ?? u.repo} · ${u.path} (feature ${u.feature})${u.note ? ` — ${clip(u.note, 200)}` : ""}`);
    }
  }
  return out.join("\n");
}

export function describeActivity(list: ActivityCard[], heading = "Running right now in the tree:"): string {
  if (!list.length) return "Nothing is running in the tree right now.";
  const out = [heading];
  for (const a of list) {
    out.push(
      `- run ${a.executionId} · ${a.team}${a.person ? ` · ${a.person}` : ""} · ${a.workflow} · ${a.status} since ${a.startedAt.slice(0, 16).replace("T", " ")}${a.repo ? ` · repo ${a.repo}` : ""}${a.branch ? ` · branch ${a.branch}` : ""}${a.taskId ? ` · task ${a.taskId}` : ""}`,
    );
    out.push(`  ${clip(a.task.replace(/\s+/g, " "), 300)}`);
    if (a.shared.length) out.push(`  in common: ${a.shared.join(", ")}`);
  }
  return out.join("\n");
}

export function describeHistory(h: HistoryResult): string {
  if (h.unavailable) return `No history: ${h.unavailable}`;
  if (!h.commits.length) return `No commit on ${h.repoId ?? h.repo}'s ${h.ref ?? "base branch"} (at ${h.commit?.slice(0, 8)}) touched these paths in that window.`;
  const out = [`${h.commits.length} commit${h.commits.length === 1 ? "" : "s"} on ${h.repoId ?? h.repo}'s ${h.ref ?? "base branch"} at ${h.commit?.slice(0, 8)}, newest first:`];
  for (const c of h.commits) {
    out.push(`- ${c.sha.slice(0, 10)} · ${c.date.slice(0, 10)} · ${c.author} · ${c.subject}`);
    if (c.documents.length) out.push(`  record: ${c.documents.join(", ")}`);
    if (c.runs.length) out.push(`  run: ${c.runs.join(", ")}`);
  }
  return out.join("\n");
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
  } else if (!detail.documents?.length) {
    out.push("No team has recorded an implementation of it yet.");
  }
  if (detail.documents?.length) {
    // The design doc is each team's own statement of how the feature works,
    // read from its base branch; the summaries above are memory's.
    out.push("\nEach repository's design doc for it:");
    for (const d of detail.documents) out.push(describeDocument(d));
  }
  if (detail.decisions.length) {
    out.push(`\nDecisions (${detail.decisions.length}):`);
    for (const d of detail.decisions) out.push(describeDecision(d));
  }
  if (detail.issues.length) out.push(describeIssues(detail.issues, detail.own));
  return out.filter((l) => l !== "").join("\n");
}
