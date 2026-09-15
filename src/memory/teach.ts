import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { createExecution, finishExecution, recordStep, setExecutionDiff } from "@/executions/store";
import type { teachSchema } from "@/lib/client-api-schemas";
import { getDb } from "@/lib/db";
import { canonicalRepoId } from "@/repos/identity";
import { createState } from "@/runtime/state";

import { getExtraction, memoryScopeFor, requeueExtraction } from "./store";
import { TEACH_WORKFLOW_ID } from "./types";

/**
 * Teaching: a branch whose work was done before the team recorded runs,
 * recorded the way a run is.
 *
 * Nothing about the record is special. The branch becomes a finished run of
 * its own — `gate:teach`, with the session's account of the work where a
 * run's agents would have answered and the branch's commits beside it — and
 * the run is put in the recorder's ledger like every other. The recorder
 * then writes its decisions, files it under a feature and updates the team's
 * summary in exactly the format a run gets, because it is the same code
 * reading the same kind of thing. A second format for "old work" would be a
 * second memory nobody searches the same way.
 *
 * A branch is taught once: teaching it again replaces what the first
 * teaching wrote, and a branch a run already recorded is refused unless the
 * person says otherwise, so the same work does not appear twice.
 */

export type TeachBody = z.output<typeof teachSchema>;

export type TeachOutcome =
  | { ok: true; executionId: string; replaced: boolean }
  | { ok: false; code: "ALREADY_RECORDED"; executionId: string; workflowId: string }
  | { ok: false; code: "RECORDING"; executionId: string };

/** The run, in the team's tree, that already worked on this branch or produced this commit. */
function recordedBy(teams: string[], branch: string, commit: string): { id: string; workflow_id: string } | null {
  const row = getDb()
    .prepare(
      `SELECT id, workflow_id FROM workflow_executions
        WHERE COALESCE(team_id, 'default') IN (${teams.map(() => "?").join(",")})
          AND workflow_id != ?
          AND workspace_json IS NOT NULL
          AND (json_extract(workspace_json, '$.commit') = ? OR json_extract(workspace_json, '$.branch') = ?)
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(...teams, TEACH_WORKFLOW_ID, commit, branch) as { id: string; workflow_id: string } | undefined;
  return row ?? null;
}

/**
 * An earlier teaching of the same work: the same branch cut from the same
 * commit. Commits added to the branch since are the same work grown, so they
 * replace it rather than stand beside it.
 */
function taughtBefore(teamId: string, branch: string, baseCommit: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM workflow_executions
        WHERE COALESCE(team_id, 'default') = ? AND workflow_id = ?
          AND json_extract(workspace_json, '$.branch') = ?
          AND json_extract(workspace_json, '$.baseCommit') = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(teamId, TEACH_WORKFLOW_ID, branch, baseCommit) as { id: string } | undefined;
  return row?.id ?? null;
}

export function teachBranch(who: { teamId: string; userId: string | null }, body: TeachBody): TeachOutcome {
  const { account, commits, workspace } = body;
  const scope = memoryScopeFor(who.teamId);

  if (!body.force) {
    const prior = recordedBy(scope.teams, workspace.branch, workspace.commit);
    if (prior) return { ok: false, code: "ALREADY_RECORDED", executionId: prior.id, workflowId: prior.workflow_id };
  }

  const input = { task: account.task };
  const client = { host: body.host ?? null, repo: workspace.repo, branch: workspace.branch, version: body.version ?? null };
  const existing = taughtBefore(who.teamId, workspace.branch, workspace.baseCommit);
  // Taught work belongs to a repository as much as a run's does: without it
  // the paths in the account are bare, and `src/index.ts` taught from the
  // desktop app would answer a question about the server's.
  const repoId = workspace.remoteUrl ? canonicalRepoId(workspace.remoteUrl) : null;
  const db = getDb();

  let executionId: string;
  if (existing) {
    // The recorder may be writing the first teaching right now; replacing
    // its steps under it would record half of each.
    if (getExtraction(existing)?.status === "running") return { ok: false, code: "RECORDING", executionId: existing };
    executionId = existing;
    db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id = ?").run(executionId);
    db.prepare(
      `UPDATE workflow_executions
          SET status = 'running', started_at = ?, input_json = ?, user_id = ?, client_host = ?, client_repo = ?, client_branch = ?,
              repo_id = COALESCE(?, repo_id), error_code = NULL, error_message = NULL
        WHERE id = ?`,
    ).run(body.startedAt, JSON.stringify(input), who.userId, client.host, client.repo, client.branch, repoId, executionId);
  } else {
    executionId = randomUUID();
    createExecution(executionId, TEACH_WORKFLOW_ID, input, body.startedAt, null, {
      origin: "local",
      userId: who.userId,
      teamId: who.teamId,
      client,
      repoId,
    });
  }

  // Two steps, as a run's agents would have left them: the account first,
  // then the branch's own history for the recorder to check it against.
  //
  // Written with `recordStep` rather than `recordReportedSteps`, so no
  // objection is raised from either one. That is deliberate: these steps are
  // a person's account of work already finished, not a planner saying it
  // cannot live with another team's decision. An objection is a claim about
  // what should happen next, and a branch that has already landed makes none.
  // Teaching a branch must never post to another team in that team's absence.
  recordStep(executionId, {
    nodeId: "teach",
    stepIndex: 0,
    visit: 1,
    status: "completed",
    startedAt: body.startedAt,
    finishedAt: body.finishedAt,
    input: { branch: workspace.branch, base: workspace.baseCommit, head: workspace.commit },
    output: account,
  });
  recordStep(executionId, {
    nodeId: "commits",
    stepIndex: 1,
    visit: 1,
    status: "completed",
    startedAt: body.startedAt,
    finishedAt: body.finishedAt,
    input: {},
    output: { commits },
  });

  const state = createState(executionId, TEACH_WORKFLOW_ID, input);
  state.status = "completed";
  state.stepCount = 2;
  // Closed at the branch's last commit: that is when the decisions started
  // holding, and the recorder dates them from the run's end.
  finishExecution(state, workspace, body.finishedAt);
  // A run's quota is where the account pool stood around it; a branch from
  // months ago used none of it, and a reading taken today would say it had.
  db.prepare("UPDATE workflow_executions SET quota_json = NULL WHERE id = ?").run(executionId);
  if (body.diff) setExecutionDiff(executionId, body.diff);
  // A first teaching was queued when it was closed; a second one has a
  // ledger row already, and it has to be put back in line.
  if (existing) requeueExtraction(executionId);
  return { ok: true, executionId, replaced: !!existing };
}
