import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// The recorder is driven by hand here; the route's own kick would race it
// with a real gateway call.
vi.mock("@/memory/queue", () => ({ scheduleExtraction: () => {} }));

import { GET as runMemory } from "@/app/api/v1/executions/[id]/memory/route";
import { POST as teach } from "@/app/api/v1/memory/teach/route";
import { readBranch, TeachError } from "@/client/teach";
import { createExecution, finishExecution, getExecution, getExecutionDiff, getExecutionSteps } from "@/executions/store";
import { createKey } from "@/lib/apikeys";
import { createTeam, createUser } from "@/lib/teams";
import { LocalMemoryAccess } from "@/memory/access";
import { describeSearch } from "@/memory/cards";
import { extractRun } from "@/memory/extract";
import { decisionsForExecution, getExtraction } from "@/memory/store";
import { TEACH_WORKFLOW_ID } from "@/memory/types";
import { createTask, executionsForTask } from "@/orchestration/tasks";
import { createState } from "@/runtime/state";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/**
 * Teaching: a branch finished before the team recorded runs, recorded the way
 * a run is — kept as a finished `gate:teach` run and read by the same recorder.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(repo: string, file: string, content: string, message: string, date: string) {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  execFileSync("git", ["commit", "-qm", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function aRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gate-teach-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  commit(repo, "README.md", "hello\n", "init", "2026-01-01T10:00:00Z");
  return repo;
}

describe("reading a finished branch", () => {
  it("takes the range from where the branch was cut from the default branch", () => {
    const repo = aRepo();
    git(repo, "checkout", "-q", "-b", "feature/sync");
    commit(repo, "queue.ts", "queue\n", "Add the edit queue", "2026-02-01T10:00:00Z");
    commit(repo, "flush.ts", "flush\n", "Flush the queue when online\n\nRetries with backoff.", "2026-02-03T10:00:00Z");
    git(repo, "checkout", "-q", "main");
    commit(repo, "other.ts", "other\n", "Unrelated work on main", "2026-02-04T10:00:00Z");
    git(repo, "checkout", "-q", "feature/sync");

    const r = readBranch(repo);
    expect(r.branch).toBe("feature/sync");
    expect(r.baseRef).toBe("main");
    expect(r.baseCommit).toBe(git(repo, "rev-parse", "main~1"));
    expect(r.commits.map((c) => c.subject)).toEqual(["Add the edit queue", "Flush the queue when online"]);
    expect(r.commits[1].body).toBe("Retries with backoff.");
    expect(r.changedFiles.sort()).toEqual(["flush.ts", "queue.ts"]);
    expect(r.startedAt).toBe(Date.parse("2026-02-01T10:00:00Z"));
    expect(r.finishedAt).toBe(Date.parse("2026-02-03T10:00:00Z"));
    expect(r.mergedBy).toBeNull();
  });

  it("finds where merged work began from the merge that brought it in", () => {
    const repo = aRepo();
    git(repo, "checkout", "-q", "-b", "feature/sso");
    commit(repo, "sso.ts", "sso\n", "Open the system browser for OIDC", "2026-03-01T10:00:00Z");
    git(repo, "checkout", "-q", "main");
    commit(repo, "other.ts", "other\n", "Meanwhile on main", "2026-03-02T10:00:00Z");
    const before = git(repo, "rev-parse", "HEAD");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge feature/sso", "feature/sso");
    commit(repo, "later.ts", "later\n", "Later work", "2026-03-05T10:00:00Z");
    git(repo, "checkout", "-q", "feature/sso");

    const r = readBranch(repo);
    expect(r.baseCommit).toBe(git(repo, "merge-base", before, "feature/sso"));
    expect(r.mergedBy).toBe(git(repo, "rev-parse", "main~1"));
    expect(r.commits.map((c) => c.subject)).toEqual(["Open the system browser for OIDC"]);
  });

  it("asks for --base when nothing in the history says where the work began", () => {
    const repo = aRepo();
    commit(repo, "a.ts", "a\n", "Straight on main", "2026-04-01T10:00:00Z");
    expect(() => readBranch(repo)).toThrow(TeachError);
    expect(readBranch(repo, "main~1").commits.map((c) => c.subject)).toEqual(["Straight on main"]);
  });
});

createTeam("Tau", "tau");
const ann = createUser({ email: "ann@tau.test", name: "Ann", teamId: "tau" });
const bob = createUser({ email: "bob@tau.test", name: "Bob", teamId: "tau" });
const annKey = createKey({ name: "ann laptop", userId: ann.id, teamId: "tau" }).plaintext;
const bobKey = createKey({ name: "bob laptop", userId: bob.id, teamId: "tau" }).plaintext;

const ACCOUNT = {
  task: "Keep edits made offline and send them when the network is back",
  plan: "A local queue, then a flush worker.",
  decisions: "Queue in SQLite rather than memory, so edits survive the app being killed (stated in the commit message).",
  implementation: "Every edit becomes a queue row; a worker flushes rows oldest first on connectivity and deletes each on ack.",
  verification: "Unit tests for the queue order.",
  pitfalls: "Ordering holds per entity only.",
  evidence: "Commits a1..b2 on feature/sync.",
};

function body(over: Record<string, unknown> = {}) {
  return {
    account: ACCOUNT,
    commits: [{ sha: "b2b2b2b2", date: "2026-02-03T10:00:00Z", author: "Ann", subject: "Flush the queue when online", body: "" }],
    workspace: {
      root: "/src/app",
      repo: "/src/app",
      branch: "feature/sync",
      baseRef: "origin/main",
      baseCommit: "a0a0a0a0",
      commit: "b2b2b2b2",
      changedFiles: ["app/sync/Queue.kt"],
    },
    startedAt: Date.parse("2026-02-01T10:00:00Z"),
    finishedAt: Date.parse("2026-02-03T10:00:00Z"),
    diff:
      "diff --git a/app/sync/Queue.kt b/app/sync/Queue.kt\n" +
      "diff --git a/docs/decisions/0001-sqlite-queue.md b/docs/decisions/0001-sqlite-queue.md\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/docs/decisions/0001-sqlite-queue.md\n" +
      "@@ -0,0 +1,3 @@\n" +
      "+# 0001. Queue offline edits in SQLite\n" +
      "+## Decision\n" +
      "+Every edit goes through a persistent local queue.\n",
    host: "ann-mac",
    ...over,
  };
}

const post = (key: string, payload: unknown) =>
  teach(
    new Request("http://gate.test/api/v1/memory/teach", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );

const ANSWER = {
  decisions: [
    {
      title: "Queue offline edits in SQLite",
      context: "Edits were lost offline.",
      decision: "Every edit goes through a persistent local queue.",
      rationale: "Survives the app being killed.",
      alternatives: "",
      how: "edit → row → flush on connectivity → delete on ack.",
      consequences: "Per-entity ordering only.",
      touches: [{ kind: "file", ref: "app/sync/Queue.kt" }],
    },
  ],
  feature: { match: null, name: "Offline edits", aliases: [], description: "Edits made offline reach the server later.", summary: "Queue + flush.", pitfalls: "" },
};

describe("teaching a branch", () => {
  it("keeps it as a finished run, and the recorder writes it in a run's format", async () => {
    const res = await post(annKey, body());
    expect(res.status).toBe(201);
    const { executionId, replaced } = await res.json();
    expect(replaced).toBe(false);

    const execution = getExecution(executionId)!;
    expect(execution).toMatchObject({
      workflowId: TEACH_WORKFLOW_ID,
      status: "completed",
      teamId: "tau",
      userId: ann.id,
      input: { task: ACCOUNT.task },
      finishedAt: Date.parse("2026-02-03T10:00:00Z"),
      quota: null,
    });
    expect(execution.workspace).toMatchObject({ branch: "feature/sync", baseCommit: "a0a0a0a0", commit: "b2b2b2b2" });
    expect(getExecutionSteps(executionId).map((s) => s.nodeId)).toEqual(["teach", "commits"]);
    expect(getExecutionDiff(executionId)).toContain("Queue.kt");
    expect(getExtraction(executionId)).toMatchObject({ status: "pending", teamId: "tau" });

    const provider = new FakeModelProvider(() => JSON.stringify(ANSWER));
    expect(await extractRun(executionId, provider, { model: "sonnet" })).toEqual({ status: "done", decisionCount: 1 });
    const prompt = String(provider.calls[0].messages[0].content);
    expect(prompt).toContain("taught to memory from its branch");
    expect(prompt).toContain(ACCOUNT.implementation);
    expect(prompt).toContain("Flush the queue when online");
    // The decision record in the branch's diff is read too; the code is not.
    expect(prompt).toContain("### docs/decisions/0001-sqlite-queue.md");
    expect(prompt).toContain("# 0001. Queue offline edits in SQLite");
    const [decision] = decisionsForExecution(executionId);
    expect(decision).toMatchObject({ outcome: "shipped", baseCommit: "a0a0a0a0", headCommit: "b2b2b2b2", validFrom: Date.parse("2026-02-03T10:00:00Z") });

    // Only its teacher reads what the recorder made of it.
    const params = { params: Promise.resolve({ id: executionId }) };
    const mine = await runMemory(new Request("http://gate.test/x", { headers: { authorization: `Bearer ${annKey}` } }), params);
    expect((await mine.json()).decisions[0].title).toBe("Queue offline edits in SQLite");
    const theirs = await runMemory(new Request("http://gate.test/x", { headers: { authorization: `Bearer ${bobKey}` } }), params);
    expect(theirs.status).toBe(403);

    // The same branch again — more commits, a better account — replaces it.
    const again = await post(annKey, body({ workspace: { ...body().workspace, commit: "c3c3c3c3" }, account: { ...ACCOUNT, pitfalls: "Ordering per entity; no conflict rule." } }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ executionId, replaced: true });
    expect(getExecutionSteps(executionId)).toHaveLength(2);
    expect(getExecution(executionId)!.workspace?.commit).toBe("c3c3c3c3");
    expect(getExtraction(executionId)).toMatchObject({ status: "pending" });
    expect(await extractRun(executionId, provider, { model: "sonnet" })).toEqual({ status: "done", decisionCount: 1 });
    expect(decisionsForExecution(executionId)).toHaveLength(1);
    expect(decisionsForExecution(executionId)[0].headCommit).toBe("c3c3c3c3");
  });

  it("refuses a branch a run already recorded, unless told to", async () => {
    const id = "tau-run";
    const state = createState(id, "dev", { task: "sso" });
    createExecution(id, "dev", state.input, 1_000, null, { teamId: "tau", userId: ann.id });
    state.status = "completed";
    finishExecution(state, { root: "/w", repo: "/src/app", branch: "gate/sso", baseRef: "main", baseCommit: "d0d0d0d0", commit: "e1e1e1e1", changedFiles: [] }, 2_000);

    const sso = { ...body().workspace, branch: "feature/sso", baseCommit: "d0d0d0d0", commit: "e1e1e1e1" };
    const refused = await post(annKey, body({ workspace: sso }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "ALREADY_RECORDED", executionId: id });

    expect((await post(annKey, body({ workspace: sso, force: true }))).status).toBe(201);
  });

  it("names an account field it does not know rather than dropping it", async () => {
    const res = await post(annKey, body({ account: { ...ACCOUNT, rationale: "misnamed" } }));
    expect(res.status).toBe(400);
  });
});

/**
 * A branch somebody is still in the middle of, taught so the teams building
 * against it object while the choices can still move. The whole point is the
 * word the sibling planner reads: anything but `in-progress` says settled.
 */
describe("teaching a branch that is not finished", () => {
  it("records its decisions as in-progress, and warns the planner that finds them", async () => {
    const workspace = { ...body().workspace, branch: "feature/pq", baseCommit: "aa11aa11", commit: "aa22aa22", changedFiles: ["app/crypto/Kem.kt"] };
    const res = await post(annKey, body({ workspace, wip: true }));
    expect(res.status).toBe(201);

    const { executionId } = await res.json();
    expect(getExecution(executionId)!.input).toMatchObject({ wip: true });

    const answer = {
      ...ANSWER,
      decisions: [{ ...ANSWER.decisions[0], title: "Hybrid KEM in the client handshake", touches: [{ kind: "file", ref: "app/crypto/Kem.kt" }] }],
      feature: { ...ANSWER.feature, name: "Post-quantum handshake" },
    };
    expect(
      await extractRun(executionId, new FakeModelProvider(() => JSON.stringify(answer)), { model: "sonnet" }),
    ).toEqual({ status: "done", decisionCount: 1 });
    const [decision] = decisionsForExecution(executionId);
    expect(decision.outcome).toBe("in-progress");

    // What another team actually reads. The outcome word alone is one label
    // among several; the line under it is what changes what they do.
    const brief = describeSearch(await new LocalMemoryAccess("tau").search({ paths: ["app/crypto/Kem.kt"] }));
    expect(brief).toContain("in-progress");
    expect(brief).toContain("raise an objection now rather than after it settles");
  });

  it("goes back to the person's word when the finished branch is taught again", async () => {
    const workspace = { ...body().workspace, branch: "feature/pq-done", baseCommit: "bb11bb11", commit: "bb22bb22" };
    const { executionId } = await (await post(annKey, body({ workspace, wip: true }))).json();
    expect(getExecution(executionId)!.input).toMatchObject({ wip: true });

    await post(annKey, body({ workspace }));
    expect(getExecution(executionId)!.input).not.toHaveProperty("wip");
  });
});

/**
 * Work finished before the gate saw it belongs to a cross-team task as much as
 * work done under one: teaching is usually how a task opened after the fact
 * gets anything under it at all.
 */
describe("teaching a branch under a task", () => {
  const branch = (name: string, base: string) => ({ ...body().workspace, branch: name, baseCommit: base, commit: `${base}ff` });

  it("files the teaching under it, so the task lists the branch", async () => {
    const task = createTask({ teamId: "tau", title: "Offline edits, desktop and server" });
    const res = await post(annKey, body({ workspace: branch("feature/filed", "f1f1f1f1"), taskId: task.id }));
    expect(res.status).toBe(201);

    const { executionId } = await res.json();
    expect(getExecution(executionId)!.taskId).toBe(task.id);
    expect(executionsForTask(task.id).map((e) => e.id)).toContain(executionId);
  });

  it("refuses a task outside the family, and teaches nothing", async () => {
    createTeam("Rho", "rho");
    const theirs = createTask({ teamId: "rho", title: "Not tau's work" });

    const res = await post(annKey, body({ workspace: branch("feature/outside", "f2f2f2f2"), taskId: theirs.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(executionsForTask(theirs.id)).toHaveLength(0);
  });

  it("takes the task a second teaching names, and keeps the first one's when it names none", async () => {
    const task = createTask({ teamId: "tau", title: "Named after the fact" });
    const workspace = branch("feature/late", "f3f3f3f3");

    const first = await (await post(annKey, body({ workspace }))).json();
    expect(getExecution(first.executionId)!.taskId).toBeNull();

    const named = await (await post(annKey, body({ workspace, taskId: task.id }))).json();
    expect(named).toMatchObject({ executionId: first.executionId, replaced: true });
    expect(getExecution(first.executionId)!.taskId).toBe(task.id);

    // Teaching it again without one is not a way to unfile it.
    await post(annKey, body({ workspace }));
    expect(getExecution(first.executionId)!.taskId).toBe(task.id);
  });
});
