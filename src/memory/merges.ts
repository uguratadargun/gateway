import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createExecution, finishExecution, recordStep, setExecutionDiff } from "@/executions/store";
import { getDb } from "@/lib/db";
import type { RepoRecord } from "@/repos/store";
import { createState } from "@/runtime/state";

import { MERGE_WORKFLOW_ID } from "./types";

/**
 * Merges nobody ran through gate, recorded the way a run is.
 *
 * A team that does its work by hand still merges it to its base branch, and
 * a sibling planner asking "has anyone built this" needs that work as much as
 * a run's. The record index already reads the documents such a merge brings
 * in, for nothing; this goes one step further when `memory.recordMerges` is
 * on and puts each merge in the recorder's ledger as a finished run of
 * `gate:merge` — the merged commits' messages where a run's agents would have
 * answered, the documents from the merge's diff — so the recorder writes its
 * decisions like any other. Same record, same search: a second format for
 * "work done by hand" would be a second memory nobody reads the same way.
 *
 * Only merges after the index first read the repository. The history before
 * that is `/gate:teach`'s, one branch at a time, with a person saying what the
 * branch cannot.
 */

const exec = promisify(execFile);

/** A burst of merges beyond this waits for the next read, so one read never queues an afternoon of model calls. */
const MAX_MERGES_PER_READ = 20;
/** Commits of one merge the recorder is shown. */
const MAX_COMMITS = 60;
const MAX_BODY_CHARS = 2_000;
/** The recorder reads documents out of the diff; code diffs would only crowd them. */
const MAX_DIFF_CHARS = 200_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

/** Whether gate already knows this work: a run's commit, or a teaching, inside the merged range. */
function knownToGate(repoId: string | null, commits: string[], mergeSha: string): boolean {
  const db = getDb();
  const shas = [...commits, mergeSha];
  const placeholders = shas.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT 1 FROM workflow_executions
        WHERE (published_commit IN (${placeholders}) OR json_extract(workspace_json, '$.commit') IN (${placeholders}))
          ${repoId ? "AND (repo_id IS NULL OR repo_id = ?)" : ""}
        LIMIT 1`,
    )
    .get(...shas, ...shas, ...(repoId ? [repoId] : []));
  return !!row;
}

/**
 * Records every first-parent commit on the base branch between two reads.
 * A merge commit brings in its second parent's range; a squash or a direct
 * commit is its own. Returns how many were put in the ledger.
 */
export async function recordMergesSince(repo: RepoRecord, from: string, to: string): Promise<number> {
  if (from === to || !repo.teamId) return 0;
  try {
    await git(repo.root, ["merge-base", "--is-ancestor", from, to]);
  } catch {
    // The branch was rewritten under the watermark: nothing between the two
    // is a range, and guessing one would record work twice.
    return 0;
  }
  const firstParent = (await git(repo.root, ["rev-list", "--first-parent", "--reverse", `${from}..${to}`])).split("\n").filter(Boolean);
  let recorded = 0;
  for (const sha of firstParent.slice(-MAX_MERGES_PER_READ)) {
    const already = getDb()
      .prepare("SELECT 1 FROM workflow_executions WHERE workflow_id = ? AND json_extract(workspace_json, '$.commit') = ? LIMIT 1")
      .get(MERGE_WORKFLOW_ID, sha);
    if (already) continue;
    const [, p1, p2] = (await git(repo.root, ["rev-list", "--parents", "-n", "1", sha])).trim().split(" ");
    if (!p1) continue;
    const tip = p2 ?? sha;
    const log = await git(repo.root, ["log", "--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e", "-n", String(MAX_COMMITS), `${p1}..${tip}`]);
    const commits = log
      .split("\x1e")
      .map((rec) => rec.replace(/^\n+/, "").split("\x1f"))
      .filter(([h]) => !!h && /^[0-9a-f]{40}$/.test(h))
      .map(([h, ct, author, subject, body]) => ({ sha: h, date: new Date(Number(ct) * 1000).toISOString(), author, subject, body: (body ?? "").trim().slice(0, MAX_BODY_CHARS) }));
    if (!commits.length) continue;
    if (knownToGate(repo.repoId, commits.map((c) => c.sha), sha)) continue;
    if (commits.some((c) => /gate\/run-[0-9a-f]{8}/.test(`${c.subject}\n${c.body}`))) continue;

    const files = (await git(repo.root, ["diff", "--name-only", p1, tip])).split("\n").filter(Boolean);
    const docsDiff = await git(repo.root, ["diff", p1, tip, "--", "docs/decisions", "docs/design"]);
    const mergeCommit = (await git(repo.root, ["show", "-s", "--format=%ct%x1f%s", sha])).trim().split("\x1f");
    const finishedAt = Number(mergeCommit[0]) * 1000;
    const task = mergeCommit[1] || commits[0].subject;

    const executionId = randomUUID();
    const input = { task };
    createExecution(executionId, MERGE_WORKFLOW_ID, input, Math.min(...commits.map((c) => Date.parse(c.date))), null, {
      origin: "server",
      teamId: repo.teamId,
      repoId: repo.repoId,
      client: { host: null, repo: repo.id, branch: null, version: null },
    });
    recordStep(executionId, {
      nodeId: "merge",
      stepIndex: 0,
      visit: 1,
      status: "completed",
      startedAt: finishedAt,
      finishedAt,
      input: { base: p1, head: tip, merge: sha },
      output: { task, commits: commits.map(({ sha: h, date, author, subject, body }) => ({ sha: h, date, author, subject, body })), files: files.slice(0, 500) },
    });
    const state = createState(executionId, MERGE_WORKFLOW_ID, input);
    state.status = "completed";
    state.stepCount = 1;
    finishExecution(
      state,
      { root: repo.root, repo: repo.id, branch: repo.baseRef ?? "", baseRef: p1, baseCommit: p1, commit: sha, changedFiles: files.slice(0, 500) },
      finishedAt,
    );
    // A merge from last month used none of today's quota window.
    getDb().prepare("UPDATE workflow_executions SET quota_json = NULL WHERE id = ?").run(executionId);
    if (docsDiff) setExecutionDiff(executionId, docsDiff.slice(0, MAX_DIFF_CHARS));
    recorded++;
  }
  if (recorded) {
    const { scheduleExtraction } = await import("./queue");
    scheduleExtraction();
  }
  return recorded;
}
