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

/**
 * The workflow id a taught branch is kept under: work finished before the team
 * recorded runs, read back from its branch by `gate teach`. Not a workflow
 * anyone can define — the colon is outside what a definition id may contain —
 * so a team's own "teach" pipeline can never be mistaken for one.
 */
export const TEACH_WORKFLOW_ID = "gate:teach";

/**
 * The workflow id a merge on a repository's base branch is kept under when
 * nobody ran it through gate: the record index found it, and the gate is set
 * to record such merges (`memory.recordMerges`). Like `gate:teach`, not an id
 * a definition can take, and like it, recorded by the same recorder.
 */
export const MERGE_WORKFLOW_ID = "gate:merge";

export type TouchKind = "file" | "area";

/** One thing a decision touched: a path in the repository, or a named area. */
export interface Touch {
  kind: TouchKind;
  ref: string;
}

/**
 * How far the decision actually got. An abandoned decision is still a
 * decision — but `abandoned` says only that the run did not finish, which is
 * not a judgement of the idea: a run stopped for a timeout, a flaky check or
 * a person going home carries good decisions. Whether the approach itself was
 * refused is the decision's `verdict`, a separate field.
 *
 * The four that follow a branch are separate on purpose. A merge request is
 * an *offer* to ship, and a planner on a sibling team reading "shipped" takes
 * it as settled and builds on it — which is the whole reason the word has to
 * mean what it says. `pr-open` is as far as a run can see; `merged` is written
 * by the record index when the base branch it reads holds the work (the run's
 * head in its history, or the decision record the run wrote on it). Nothing
 * assigns `deployed`: gate watches no deploy.
 *
 * `shipped` is the value rows carried before the distinction existed. It is
 * not re-derived: a row recorded as shipped stays shipped, because the
 * evidence that would say which of the three it really was is not there.
 *
 * `in-progress` is the one nobody's pipeline produces: it is claimed, by a
 * person teaching a branch they say is not finished. Work half-done is worth
 * putting in memory precisely so the teams building against it object now
 * rather than after it sets, and every other word here would have read as a
 * settled choice to the planner that found it.
 */
export type DecisionOutcome =
  | "shipped"
  | "deployed"
  | "merged"
  | "pr-open"
  | "completed"
  | "unshipped"
  | "in-progress"
  | "abandoned";

/**
 * Whether the approach itself was refused — by the reviewer, the verifier or
 * a person — as opposed to the run that tried it not finishing. Only a
 * refusal is a road already found closed; null says nobody refused it.
 */
export type DecisionVerdict = "rejected";

/** Outcomes that mean the work reached users. Not `pr-open`: that is an offer. */
export const SHIPPED_OUTCOMES: readonly DecisionOutcome[] = ["shipped", "deployed", "merged"];

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
  /** Set when the approach was refused, not merely left unfinished. */
  verdict?: DecisionVerdict | null;
  /** Who refused it and why, when `verdict` is set. */
  verdictReason?: string | null;
}

export interface Decision extends DecisionDraft {
  id: string;
  executionId: string;
  /**
   * The team the decision belongs to: the team whose repository the work was
   * in, when the repository has one, else the team that ran it. Supersession,
   * objections and a feature's per-team page all follow this.
   */
  teamId: string;
  /** The team whose run made it, when that is not the owner; null when it is, or unknown. */
  authorTeamId: string | null;
  userId: string | null;
  featureId: string | null;
  /**
   * The repository the run worked in — `host/owner/name`, or null when it is
   * not known. The paths in `touches` are relative to it and mean nothing
   * without it: `src/index.ts` is a different file in each of four repos.
   */
  repoId: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  outcome: DecisionOutcome;
  /** When the decision started holding in the world (the run's end). */
  validFrom: number;
  /** When it stopped holding; null while it still does. */
  validTo: number | null;
  recordedAt: number;
  retractedAt: number | null;
  verdict: DecisionVerdict | null;
  verdictReason: string | null;
  /**
   * The base-branch commit the record index last checked the decision's file
   * touches against, and how many of them were not there. When every file it
   * touched is gone, the decision describes code that no longer exists.
   */
  checkedCommit: string | null;
  missingTouches: number;
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
  /**
   * The repository the caller is asking from. A *path* search hides
   * decisions belonging to a different named repository — a relative path
   * means nothing in another one — and keeps the unnamed ones, because
   * unknown is not evidence of difference. A search in words reads every
   * repository of the tree and ranks this one's first: asking how a sibling
   * built something is asking about another repository. Absent means no
   * filter and no preference.
   */
  repoId?: string | null;
  featureId?: string;
  /** Only decisions that held at this moment. */
  asOf?: number;
  /** Only decisions recorded from this moment on. */
  since?: number;
  limit?: number;
  includeRetracted?: boolean;
}
