import { conflictsFieldSchema, resolvedFieldSchema } from "@/lib/client-api-schemas";
import { getDb } from "@/lib/db";
import { teamFamily } from "@/lib/teams";
import {
  findIssue,
  insertApproval,
  insertIssue,
  openIssue,
  pendingApprovals,
  pendingApprovalsFor,
  rejectIssue,
  settleApproval,
  type IssueApproval,
} from "@/memory/issues";
import type { StepRecord } from "@/runtime/state";

import { attributeSessionUsage, recordStep } from "./store";
import type { ExecutionRecord } from "./types";

/**
 * Keeping a run's steps, and everything that follows from keeping one.
 *
 * A step used to be a row and nothing more, so writing it could not half
 * happen. Now an agent's output can raise an objection against another team's
 * decision, or carry a person's answer to one, and those are rows in other
 * tables — a step written without them would leave an objection that was
 * raised and never recorded, and a report the client will never send again.
 * So every step in a report is written in one transaction with whatever it
 * implies: all of it, or none of it and a 500 the client retries.
 *
 * Nothing here awaits. The database is a single synchronous connection shared
 * by the whole process, so a transaction open across an `await` would have
 * another request's writes inside it.
 */

/** Why one part of a step's output changed nothing, in words worth showing. */
export interface SkippedEffect {
  stepIndex: number;
  field: "conflicts" | "resolved";
  /** The item's key when it had a readable one. */
  key?: string;
  reason: string;
}

export interface ReportOutcome {
  /** Steps this call wrote, as opposed to ones that had already arrived. */
  recorded: number;
  issuesRaised: number;
  approvalsKept: number;
  /** Answers whose objection has not arrived yet; they wait, they are not lost. */
  approvalsPending: number;
  skipped: SkippedEffect[];
}

function emptyOutcome(): ReportOutcome {
  return { recorded: 0, issuesRaised: 0, approvalsKept: 0, approvalsPending: 0, skipped: [] };
}

/**
 * Writes a report's steps and their consequences, or writes nothing.
 *
 * The transaction is opened here rather than by the callers so that there is
 * exactly one place that opens one — a second `BEGIN` on this connection would
 * throw, and the engine-side runner reports its steps through this same door.
 */
export function recordReportedSteps(execution: ExecutionRecord, steps: StepRecord[], now = Date.now()): ReportOutcome {
  if (!steps.length) return emptyOutcome();
  const db = getDb();
  const outcome = emptyOutcome();
  db.exec("BEGIN");
  try {
    for (const step of steps) {
      const { inserted } = recordStep(execution.id, step);
      if (!inserted) continue;
      outcome.recorded += 1;
      // A step the session did itself arrives without usage: its model calls
      // went through the person's own Claude Code. What that session spent in
      // the step's minutes is the nearest true figure, and it is marked as one.
      if (execution.driver === "session" && step.costing === "session" && !step.usage && step.status === "completed") {
        attributeSessionUsage(execution.id, step.stepIndex);
      }
      applyStepEffects(execution, step, outcome, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return outcome;
}

function outputOf(step: StepRecord): Record<string, unknown> | null {
  return step.output && typeof step.output === "object" && !Array.isArray(step.output)
    ? (step.output as Record<string, unknown>)
    : null;
}

/**
 * The parts of a step's output that mean something outside its own run.
 *
 * Both fields are optional and both are read leniently: a model that answered
 * `conflicts: "none"` is describing its own state of mind, not sending a
 * malformed protocol message, and refusing the whole report over it would cost
 * the run every step it had left to send. The item is skipped and the reason
 * is carried back so somebody can see it happened.
 */
function applyStepEffects(execution: ExecutionRecord, step: StepRecord, outcome: ReportOutcome, now: number): void {
  const output = outputOf(step);
  if (!output) return;
  if (output.conflicts !== undefined) applyConflicts(execution, step, output.conflicts, outcome, now);
  if (output.resolved !== undefined) applyResolutions(execution, step, output.resolved, outcome, now);
}

function applyConflicts(
  execution: ExecutionRecord,
  step: StepRecord,
  raw: unknown,
  outcome: ReportOutcome,
  now: number,
): void {
  const parsed = conflictsFieldSchema.safeParse(raw);
  if (!parsed.success) {
    outcome.skipped.push({ stepIndex: step.stepIndex, field: "conflicts", reason: reasonFor(parsed.error.issues) });
    return;
  }
  // The family is the boundary everywhere else in memory, so it is the
  // boundary here: a run may object to a sibling team's decision because it
  // can read that decision, and to nothing outside the tree it lives in.
  const family = new Set(teamFamily(execution.teamId));
  const seen = new Set<string>();
  for (const c of parsed.data) {
    if (seen.has(c.conflictKey)) {
      outcome.skipped.push({ stepIndex: step.stepIndex, field: "conflicts", key: c.conflictKey, reason: "two objections share one key in this step" });
      continue;
    }
    seen.add(c.conflictKey);
    if (c.targetTeamId === execution.teamId) {
      outcome.skipped.push({ stepIndex: step.stepIndex, field: "conflicts", key: c.conflictKey, reason: "a team does not object to itself; that is a decision" });
      continue;
    }
    if (!family.has(c.targetTeamId)) {
      outcome.skipped.push({ stepIndex: step.stepIndex, field: "conflicts", key: c.conflictKey, reason: `team ${c.targetTeamId} is not in this run's family` });
      continue;
    }
    const written = insertIssue(
      {
        executionId: execution.id,
        stepIndex: step.stepIndex,
        sourceNodeId: step.nodeId,
        sourceVisit: step.visit,
        conflictKey: c.conflictKey,
        fromTeamId: execution.teamId,
        targetTeamId: c.targetTeamId,
        decisionId: c.decisionId ?? null,
        featureId: c.featureId ?? null,
        paths: c.paths,
        repoSource: execution.workspace?.repo ?? null,
        sourceCommit: execution.workspace?.baseCommit ?? null,
        taskId: execution.taskId,
        title: c.title,
        decisionSnapshot: c.decisionSnapshot,
        rationale: c.rationale,
        proposal: c.proposal,
        revision: c.revision,
      },
      now,
    );
    if ("ambiguous" in written) {
      // The same (node, visit, key) under a second step index: two different
      // steps claiming to be the same objection. There is no right answer to
      // pick, so neither is applied.
      outcome.skipped.push({ stepIndex: step.stepIndex, field: "conflicts", key: c.conflictKey, reason: "this node and visit already raised this key under another step" });
      continue;
    }
    if (!written.created) continue;
    outcome.issuesRaised += 1;
    // The answer may have arrived before the question: a person can confirm
    // an objection in the same report that first carries it, and a batch can
    // be re-sent out of order. Whatever was waiting on this step settles now.
    for (const waiting of pendingApprovalsFor(execution.id, step.nodeId, step.visit)) {
      if (waiting.conflictKey !== c.conflictKey) continue;
      if (reconcile(waiting, now)) outcome.approvalsPending -= 1;
    }
  }
}

function applyResolutions(
  execution: ExecutionRecord,
  step: StepRecord,
  raw: unknown,
  outcome: ReportOutcome,
  now: number,
): void {
  const parsed = resolvedFieldSchema.safeParse(raw);
  if (!parsed.success) {
    outcome.skipped.push({ stepIndex: step.stepIndex, field: "resolved", reason: reasonFor(parsed.error.issues) });
    return;
  }
  for (const r of parsed.data) {
    const { approval, created } = insertApproval(
      {
        executionId: execution.id,
        stepIndex: step.stepIndex,
        nodeId: step.nodeId,
        visit: step.visit,
        sourceNodeId: r.sourceNodeId,
        sourceVisit: r.sourceVisit,
        conflictKey: r.conflictKey,
        decision: r.decision,
        note: r.note,
      },
      now,
    );
    if (!created) continue;
    outcome.approvalsKept += 1;
    // The answer is kept whether or not its objection is here yet. That is the
    // whole point of writing it down: a client whose earlier batch was refused
    // still has the person's word, and it must not be the thing that is lost.
    if (!reconcile(approval, now)) outcome.approvalsPending += 1;
  }
}

/**
 * Matches one answer to the objection it is about.
 *
 * Returns false only when the objection has not arrived — then the answer
 * stays `pending_source` and is tried again when its step lands or when the
 * server next sweeps. Everything else settles, including the answers that turn
 * out to contradict one already given: those are kept and marked, because two
 * people disagreeing is a thing to show, not an error to swallow.
 */
export function reconcile(approval: IssueApproval, now = Date.now()): boolean {
  const issue = findIssue(approval.executionId, approval.sourceNodeId, approval.sourceVisit, approval.conflictKey);
  if (!issue) return false;

  if (approval.decision === "confirm") {
    // An approval only ever makes an objection *open* — a request the other
    // team can read and answer. It does not touch their decision's validity,
    // and nothing here ever will.
    if (openIssue(issue.id, approval.id, now)) {
      settleApproval(approval.id, { status: "applied", issueId: issue.id }, now);
      return true;
    }
    if (issue.openedBy === approval.id) {
      settleApproval(approval.id, { status: "applied", issueId: issue.id }, now);
      return true;
    }
    // Past `proposed` already. A late confirmation never reopens settled work.
    const contradicted = issue.status === "rejected" || issue.status === "withdrawn";
    settleApproval(
      approval.id,
      { status: contradicted ? "rejected" : "applied", reason: `objection was already ${issue.status}`, issueId: issue.id, conflicted: contradicted },
      now,
    );
    return true;
  }

  // A refusal only counts while nobody has answered yet. Once an objection is
  // open, closing it belongs to the team it was raised against — a second
  // answer from this side would otherwise quietly undo the first person's, and
  // two people disagreeing must show as two people disagreeing.
  if (issue.status === "proposed" && rejectIssue(issue.id, approval.note || "refused", now)) {
    settleApproval(approval.id, { status: "applied", issueId: issue.id }, now);
    return true;
  }
  const contradicted = issue.status === "open" || issue.status === "resolved";
  settleApproval(
    approval.id,
    { status: "rejected", reason: `objection was already ${issue.status}`, issueId: issue.id, conflicted: contradicted },
    now,
  );
  return true;
}

/**
 * Tries every answer still waiting for its objection.
 *
 * A source step can be lost for good — the client gave up on the batch that
 * carried it, or the run died with it unsent — so this is not a queue that
 * drains; it is a sweep that settles what can be settled and leaves the rest
 * visibly waiting. Run it when the server starts, because a pending answer
 * whose objection arrived in a later report has nobody else to notice.
 */
export function reconcilePendingApprovals(now = Date.now()): { settled: number; waiting: number } {
  const db = getDb();
  const waiting = pendingApprovals();
  if (!waiting.length) return { settled: 0, waiting: 0 };
  let settled = 0;
  db.exec("BEGIN");
  try {
    for (const approval of waiting) if (reconcile(approval, now)) settled += 1;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { settled, waiting: waiting.length - settled };
}

function reasonFor(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const first = issues[0];
  if (!first) return "not in the shape this protocol expects";
  const where = first.path.map(String).join(".");
  return where ? `${where}: ${first.message}` : first.message;
}
