import { randomBytes } from "node:crypto";

import { getDb } from "@/lib/db";

import type { MemoryScope } from "./types";

/**
 * Objections one team's run raised against another's decision, and the answers
 * people gave to them.
 *
 * This is the part of memory that travels *between* teams. A decision is a
 * team's own record and only that team may close it; an objection is how a
 * sibling says "this does not work on our side" in a way the sibling's next
 * planner will actually read. It is a proposal throughout — nothing here ever
 * writes `valid_to` on somebody else's decision.
 */

export type IssueStatus = "proposed" | "open" | "resolved" | "withdrawn" | "rejected";
export type ApprovalStatus = "pending_source" | "applied" | "rejected";

/** Statuses a target team's planner is shown: the objection is still live. */
export const LIVE_ISSUE_STATUSES: readonly IssueStatus[] = ["proposed", "open"];

export interface DecisionIssue {
  id: string;
  executionId: string;
  stepIndex: number;
  sourceNodeId: string;
  sourceVisit: number;
  conflictKey: string;
  fromTeamId: string;
  targetTeamId: string;
  decisionId: string | null;
  featureId: string | null;
  paths: string[];
  repoSource: string | null;
  sourceCommit: string | null;
  title: string;
  decisionSnapshot: string;
  rationale: string;
  proposal: string;
  revision: string;
  status: IssueStatus;
  /** The approval record that moved it to `open`, if one did. */
  openedBy: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface IssueApproval {
  id: string;
  executionId: string;
  stepIndex: number;
  nodeId: string;
  visit: number;
  sourceNodeId: string;
  sourceVisit: number;
  conflictKey: string;
  decision: "confirm" | "reject";
  note: string;
  status: ApprovalStatus;
  reason: string | null;
  issueId: string | null;
  /** Another answer already settled this objection, differently. */
  conflicted: boolean;
  reportedAt: number;
  settledAt: number | null;
}

function id(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function parsePaths(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rowToIssue(r: any): DecisionIssue {
  return {
    id: r.id,
    executionId: r.execution_id,
    stepIndex: Number(r.step_index),
    sourceNodeId: r.source_node_id,
    sourceVisit: Number(r.source_visit),
    conflictKey: r.conflict_key,
    fromTeamId: r.from_team_id,
    targetTeamId: r.target_team_id,
    decisionId: r.decision_id ?? null,
    featureId: r.feature_id ?? null,
    paths: parsePaths(r.paths_json),
    repoSource: r.repo_source ?? null,
    sourceCommit: r.source_commit ?? null,
    title: r.title,
    decisionSnapshot: r.decision_snapshot ?? "",
    rationale: r.rationale ?? "",
    proposal: r.proposal ?? "",
    revision: r.revision ?? "",
    status: r.status as IssueStatus,
    openedBy: r.opened_by ?? null,
    resolution: r.resolution ?? null,
    resolvedBy: r.resolved_by ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToApproval(r: any): IssueApproval {
  return {
    id: r.id,
    executionId: r.execution_id,
    stepIndex: Number(r.step_index),
    nodeId: r.node_id,
    visit: Number(r.visit),
    sourceNodeId: r.source_node_id,
    sourceVisit: Number(r.source_visit),
    conflictKey: r.conflict_key,
    decision: r.decision as "confirm" | "reject",
    note: r.note ?? "",
    status: r.status as ApprovalStatus,
    reason: r.reason ?? null,
    issueId: r.issue_id ?? null,
    conflicted: !!r.conflicted,
    reportedAt: Number(r.reported_at),
    settledAt: r.settled_at == null ? null : Number(r.settled_at),
  };
}

// ── Objections ───────────────────────────────────────────────────────────────

export interface IssueDraft {
  executionId: string;
  stepIndex: number;
  sourceNodeId: string;
  sourceVisit: number;
  conflictKey: string;
  fromTeamId: string;
  targetTeamId: string;
  decisionId?: string | null;
  featureId?: string | null;
  paths?: string[];
  repoSource?: string | null;
  sourceCommit?: string | null;
  title: string;
  decisionSnapshot?: string;
  rationale?: string;
  proposal?: string;
  revision?: string;
}

/**
 * Writes an objection the first time its step is seen.
 *
 * Both unique indexes are treated as "already there", not as an error: a
 * client that resends a batch must not make a second objection, and one that
 * reports the same (node, visit, key) under a second step index is reporting
 * something ambiguous — that is refused, and the caller is told which.
 */
export function insertIssue(draft: IssueDraft, now = Date.now()): { issue: DecisionIssue; created: boolean } | { ambiguous: true } {
  const db = getDb();
  const existing = findIssue(draft.executionId, draft.sourceNodeId, draft.sourceVisit, draft.conflictKey);
  if (existing) {
    if (existing.stepIndex !== draft.stepIndex) return { ambiguous: true };
    return { issue: existing, created: false };
  }
  const row: DecisionIssue = {
    id: id("iss"),
    executionId: draft.executionId,
    stepIndex: draft.stepIndex,
    sourceNodeId: draft.sourceNodeId,
    sourceVisit: draft.sourceVisit,
    conflictKey: draft.conflictKey,
    fromTeamId: draft.fromTeamId,
    targetTeamId: draft.targetTeamId,
    decisionId: draft.decisionId ?? null,
    featureId: draft.featureId ?? null,
    paths: draft.paths ?? [],
    repoSource: draft.repoSource ?? null,
    sourceCommit: draft.sourceCommit ?? null,
    title: draft.title,
    decisionSnapshot: draft.decisionSnapshot ?? "",
    rationale: draft.rationale ?? "",
    proposal: draft.proposal ?? "",
    revision: draft.revision ?? "",
    status: "proposed",
    openedBy: null,
    resolution: null,
    resolvedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO decision_issues
       (id, execution_id, step_index, source_node_id, source_visit, conflict_key, from_team_id, target_team_id,
        decision_id, feature_id, paths_json, repo_source, source_commit, title, decision_snapshot, rationale,
        proposal, revision, status, opened_by, resolution, resolved_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.executionId, row.stepIndex, row.sourceNodeId, row.sourceVisit, row.conflictKey, row.fromTeamId,
    row.targetTeamId, row.decisionId, row.featureId, JSON.stringify(row.paths), row.repoSource, row.sourceCommit,
    row.title, row.decisionSnapshot, row.rationale, row.proposal, row.revision, row.status, row.openedBy,
    row.resolution, row.resolvedBy, row.createdAt, row.updatedAt,
  );
  return { issue: row, created: true };
}

export function getIssue(issueId: string): DecisionIssue | null {
  const row = getDb().prepare("SELECT * FROM decision_issues WHERE id = ?").get(issueId);
  return row ? rowToIssue(row) : null;
}

export function findIssue(executionId: string, sourceNodeId: string, sourceVisit: number, conflictKey: string): DecisionIssue | null {
  const row = getDb()
    .prepare("SELECT * FROM decision_issues WHERE execution_id = ? AND source_node_id = ? AND source_visit = ? AND conflict_key = ?")
    .get(executionId, sourceNodeId, sourceVisit, conflictKey);
  return row ? rowToIssue(row) : null;
}

export function issuesForExecution(executionId: string): DecisionIssue[] {
  return (getDb().prepare("SELECT * FROM decision_issues WHERE execution_id = ? ORDER BY step_index, conflict_key").all(executionId) as unknown[]).map(rowToIssue);
}

/**
 * Moves an objection to `open`, and only from `proposed`.
 *
 * The expected-state condition is the whole guard: an answer that arrives
 * after the objection was resolved or withdrawn changes nothing, so a late or
 * replayed confirmation cannot reopen closed work.
 */
export function openIssue(issueId: string, approvalId: string, now = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE decision_issues SET status = 'open', opened_by = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
        .run(approvalId, now, issueId).changes,
    ) > 0
  );
}

/** A person said the objection was wrong. It stays, visibly refused. */
export function rejectIssue(issueId: string, reason: string, now = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE decision_issues SET status = 'rejected', resolution = ?, updated_at = ? WHERE id = ? AND status IN ('proposed','open')")
        .run(reason, now, issueId).changes,
    ) > 0
  );
}

/**
 * Closes an objection as dealt with. Only the team whose decision was
 * objected to may do this — a successful run on the objecting side is not
 * evidence that the other team accepted anything.
 */
export function resolveIssue(issueId: string, by: string, resolution: string, now = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE decision_issues SET status = 'resolved', resolution = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status IN ('proposed','open')")
        .run(resolution, by, now, issueId).changes,
    ) > 0
  );
}

/** The team that raised it takes it back. Their own to withdraw, nobody else's. */
export function withdrawIssue(issueId: string, now = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare("UPDATE decision_issues SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status IN ('proposed','open')")
        .run(now, issueId).changes,
    ) > 0
  );
}

// ── Answers ──────────────────────────────────────────────────────────────────

export interface ApprovalDraft {
  executionId: string;
  stepIndex: number;
  nodeId: string;
  visit: number;
  sourceNodeId: string;
  sourceVisit: number;
  conflictKey: string;
  decision: "confirm" | "reject";
  note?: string;
}

/**
 * Keeps a person's answer, whether or not the step it is about has arrived.
 *
 * A second report of the same answer finds the row already there and returns
 * it unchanged, so reconciliation runs once however many times the batch is
 * resent.
 */
export function insertApproval(draft: ApprovalDraft, now = Date.now()): { approval: IssueApproval; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM decision_issue_approvals
        WHERE execution_id = ? AND step_index = ? AND source_node_id = ? AND source_visit = ? AND conflict_key = ?`,
    )
    .get(draft.executionId, draft.stepIndex, draft.sourceNodeId, draft.sourceVisit, draft.conflictKey);
  if (existing) return { approval: rowToApproval(existing), created: false };
  const row: IssueApproval = {
    id: id("apr"),
    executionId: draft.executionId,
    stepIndex: draft.stepIndex,
    nodeId: draft.nodeId,
    visit: draft.visit,
    sourceNodeId: draft.sourceNodeId,
    sourceVisit: draft.sourceVisit,
    conflictKey: draft.conflictKey,
    decision: draft.decision,
    note: draft.note ?? "",
    status: "pending_source",
    reason: null,
    issueId: null,
    conflicted: false,
    reportedAt: now,
    settledAt: null,
  };
  db.prepare(
    `INSERT INTO decision_issue_approvals
       (id, execution_id, step_index, node_id, visit, source_node_id, source_visit, conflict_key, decision, note,
        status, reason, issue_id, conflicted, reported_at, settled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.executionId, row.stepIndex, row.nodeId, row.visit, row.sourceNodeId, row.sourceVisit, row.conflictKey,
    row.decision, row.note, row.status, row.reason, row.issueId, row.conflicted ? 1 : 0, row.reportedAt, row.settledAt,
  );
  return { approval: row, created: true };
}

export function getApproval(approvalId: string): IssueApproval | null {
  const row = getDb().prepare("SELECT * FROM decision_issue_approvals WHERE id = ?").get(approvalId);
  return row ? rowToApproval(row) : null;
}

/** Answers still waiting for one particular source step. */
export function pendingApprovalsFor(executionId: string, sourceNodeId: string, sourceVisit: number): IssueApproval[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM decision_issue_approvals
          WHERE status = 'pending_source' AND execution_id = ? AND source_node_id = ? AND source_visit = ?
          ORDER BY reported_at, id`,
      )
      .all(executionId, sourceNodeId, sourceVisit) as unknown[]
  ).map(rowToApproval);
}

/** Every answer still waiting, oldest first. What a restart sweeps. */
export function pendingApprovals(limit = 500): IssueApproval[] {
  return (
    getDb()
      .prepare("SELECT * FROM decision_issue_approvals WHERE status = 'pending_source' ORDER BY reported_at, id LIMIT ?")
      .all(limit) as unknown[]
  ).map(rowToApproval);
}

/**
 * How many answers a scope's own runs took that never found their objection.
 *
 * This is the one state a reader must not mistake for agreement: a person sat
 * down, read the objection and confirmed it, and the step carrying the
 * objection never reached the server — the run was cut off, or its batch was
 * refused four times and dropped. The answer is kept; the objection it was
 * about does not exist here; nobody on the other team will ever see it. It is
 * counted so that a planner is told, rather than reading an empty list as
 * "nothing was raised".
 */
export function heldAnswerCount(scope: MemoryScope): number {
  const teams = scope.teams.length ? scope.teams : [scope.own];
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) c FROM decision_issue_approvals a
         JOIN workflow_executions e ON e.id = a.execution_id
        WHERE a.status = 'pending_source' AND e.team_id IN (${teams.map(() => "?").join(",")})`,
    )
    .get(...(teams as never[]));
  return Number(row?.c ?? 0);
}

export function approvalsForExecution(executionId: string): IssueApproval[] {
  return (getDb().prepare("SELECT * FROM decision_issue_approvals WHERE execution_id = ? ORDER BY step_index, id").all(executionId) as unknown[]).map(rowToApproval);
}

export function settleApproval(
  approvalId: string,
  settled: { status: ApprovalStatus; reason?: string | null; issueId?: string | null; conflicted?: boolean },
  now = Date.now(),
): boolean {
  return (
    Number(
      getDb()
        .prepare(
          `UPDATE decision_issue_approvals
              SET status = ?, reason = ?, issue_id = ?, conflicted = ?, settled_at = ?
            WHERE id = ? AND status = 'pending_source'`,
        )
        .run(settled.status, settled.reason ?? null, settled.issueId ?? null, settled.conflicted ? 1 : 0, now, approvalId).changes,
    ) > 0
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface IssueSearch {
  /** Path prefixes the objection touches, as the decision search uses them. */
  paths?: string[];
  featureId?: string | null;
  decisionIds?: string[];
  limit?: number;
}

/**
 * The live objections a scope should be shown.
 *
 * Both directions matter: a team needs the objections raised *against* its
 * decisions (that is the whole postquantum case — desktop has to learn the
 * server disagreed) and the ones its own runs raised, so a planner does not
 * raise the same one twice. Scope is the family, in SQL, as everywhere else
 * in memory.
 */
export function liveIssues(scope: MemoryScope, search: IssueSearch = {}): DecisionIssue[] {
  const teams = scope.teams.length ? scope.teams : [scope.own];
  const teamHoles = teams.map(() => "?").join(",");
  const where: string[] = [
    `status IN (${LIVE_ISSUE_STATUSES.map(() => "?").join(",")})`,
    `(target_team_id IN (${teamHoles}) OR from_team_id IN (${teamHoles}))`,
  ];
  const args: unknown[] = [...LIVE_ISSUE_STATUSES, ...teams, ...teams];

  const paths = (search.paths ?? []).map((p) => p.trim().replace(/^\.\//, "")).filter(Boolean).slice(0, 50);
  const decisionIds = (search.decisionIds ?? []).slice(0, 50);
  const any: string[] = [];
  for (const p of paths) {
    // The objection's paths are stored as a JSON array; a prefix match against
    // each element is what makes "this file" find "this directory's decision".
    any.push(`EXISTS (SELECT 1 FROM json_each(decision_issues.paths_json) WHERE json_each.value = ? OR json_each.value LIKE ? OR ? LIKE json_each.value || '/%')`);
    args.push(p, `${p}/%`, p);
  }
  if (search.featureId) {
    any.push("feature_id = ?");
    args.push(search.featureId);
  }
  if (decisionIds.length) {
    any.push(`decision_id IN (${decisionIds.map(() => "?").join(",")})`);
    args.push(...decisionIds);
  }
  if (any.length) where.push(`(${any.join(" OR ")})`);

  const limit = Math.min(Math.max(search.limit ?? 20, 1), 100);
  args.push(limit);
  return (
    getDb()
      .prepare(`SELECT * FROM decision_issues WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id LIMIT ?`)
      .all(...(args as never[])) as unknown[]
  ).map(rowToIssue);
}
