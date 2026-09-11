/**
 * What a run leaves behind for the runs after it.
 *
 * A run's steps are its transcript; this is its record: what was decided,
 * why, and how, at the level of logic rather than code, with what it touched.
 * Three layers, each read for a different question:
 *
 * - a **decision** is one run's own account, never rewritten (a decision that
 *   stops holding is retracted, and the new one names it in `supersedes`);
 * - a **feature** is the catalogue entry every team in a tree shares — one
 *   name for "offline sync", whichever team built it — with an
 *   **implementation** row per team saying how that team did it;
 * - an **extraction** is the ledger row that says whether a run's decisions
 *   have been written yet, so a run is recorded once and a failure is retried.
 */

export type TouchKind = "file" | "area";

/** One thing a decision touched: a path in the repository, or a named area. */
export interface Touch {
  kind: TouchKind;
  ref: string;
}

/**
 * How the run that made the decision ended. An abandoned decision is still a
 * decision — "we tried X and the reviewer refused it because Y" is exactly
 * what the next planner should know.
 */
export type DecisionOutcome = "shipped" | "unshipped" | "abandoned";

/** The fields the recorder produces for one decision. */
export interface DecisionDraft {
  title: string;
  /** What was true before, and what the change was for. */
  context: string;
  /** What was decided, in one or two sentences. */
  decision: string;
  rationale: string;
  /** Options considered and not taken, and why. */
  alternatives: string;
  /** How it works, as logic: the flow, the states, the invariants. Not code. */
  how: string;
  /** Risks, trade-offs, and what the next change here needs to know. */
  consequences: string;
  touches: Touch[];
  /** An earlier decision this one replaces, by id. */
  supersedes?: string | null;
}

export interface Decision extends DecisionDraft {
  id: string;
  executionId: string;
  teamId: string;
  userId: string | null;
  featureId: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  outcome: DecisionOutcome;
  /** When the decision started holding in the world (the run's end). */
  validFrom: number;
  /** When it stopped holding; null while it still does. */
  validTo: number | null;
  recordedAt: number;
  retractedAt: number | null;
}

/** A decision as a search returns it: with how well it matched. */
export interface DecisionHit extends Decision {
  score: number;
}

export interface Feature {
  id: string;
  /** The root team of the tree whose catalogue this is. */
  orgId: string;
  name: string;
  aliases: string[];
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeatureHit extends Feature {
  score: number;
  /** Which teams have built it. */
  teams: string[];
}

/** How one team built a feature: the living summary over its decisions. */
export interface FeatureImplementation {
  featureId: string;
  teamId: string;
  summary: string;
  /** Kept as its own field so a consolidation pass cannot smooth it away. */
  pitfalls: string;
  decisionCount: number;
  updatedAt: number;
}

export type ExtractionStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface Extraction {
  executionId: string;
  teamId: string;
  status: ExtractionStatus;
  version: number;
  attempts: number;
  error: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  decisionCount: number;
}

/** What a search is allowed to see, worked out from the caller's team. */
export interface MemoryScope {
  /** The caller's own team: its records rank first. */
  own: string;
  /** Every team whose records may be read: the whole tree the caller is in. */
  teams: string[];
  /** The tree's root, which owns the feature catalogue. */
  orgId: string;
}

export interface DecisionSearch {
  /** Free text; matched against every field of the decision. */
  query?: string;
  /** Path prefixes; a decision matches when it touched anything under one. */
  paths?: string[];
  featureId?: string;
  /** Only decisions that held at this moment. */
  asOf?: number;
  /** Only decisions recorded from this moment on. */
  since?: number;
  limit?: number;
  includeRetracted?: boolean;
}
