import { describe, expect, it } from "vitest";

import { createExecution, finishExecution, recordStep, stopSessionExecution } from "@/executions/store";
import { createTeam, getTeam } from "@/lib/teams";
import { extractRun, parseRecorderAnswer, pathsInDiff, readableSteps } from "@/memory/extract";
import { drainExtractions } from "@/memory/queue";
import {
  decisionsForExecution,
  getExtraction,
  getFeature,
  implementationsOf,
  memoryScopeFor,
  queueUnrecordedExecutions,
  requeueExtraction,
  searchDecisions,
  searchFeatures,
  upsertFeature,
} from "@/memory/store";
import { getDb } from "@/lib/db";
import { createState } from "@/runtime/state";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/**
 * The recorder, from the outside: a run settles, a ledger row appears, the
 * model is shown the run and its answer becomes decisions — once.
 */

function team() {
  if (!getTeam("acme")) {
    createTeam("Acme", "acme");
    createTeam("Acme Android", "acme-android", "acme");
    createTeam("Acme Desktop", "acme-desktop", "acme");
  }
}

function aRun(id: string, teamId: string, status: "completed" | "failed" = "completed") {
  const state = createState(id, "dev", { task: "Add offline sync so edits survive losing the network" });
  createExecution(id, "dev", state.input, 1_000, null, { teamId, userId: "u-1" });
  recordStep(id, {
    nodeId: "base", stepIndex: 0, visit: 1, startedAt: 1_000, finishedAt: 1_001, status: "completed", input: {},
    output: { stdout: "abc123", stderr: "", ok: true, exitCode: 0 },
  });
  recordStep(id, {
    nodeId: "planner", stepIndex: 1, visit: 1, startedAt: 1_001, finishedAt: 1_100, status: "completed", input: {},
    output: { plan: "Queue edits locally, flush when online.", planFile: "docs/plans/sync.md", questions: "", notes: "" },
  });
  recordStep(id, {
    nodeId: "implementer", stepIndex: 2, visit: 1, startedAt: 1_100, finishedAt: 1_900, status: "completed", input: {},
    output: { summary: "Added a queue table and a flush worker.", changed: true },
  });
  state.stepCount = 3;
  state.status = status;
  if (status === "failed") state.error = { code: "NODE_FAILED", message: "reviewer refused" };
  finishExecution(
    state,
    { root: "/tmp/x", repo: "/tmp/r", branch: "gate/sync", baseRef: "main", baseCommit: "abc123", commit: "def456", changedFiles: ["app/sync/Queue.kt", "app/sync/Flush.kt"] },
    2_000,
  );
}

const ANSWER = {
  decisions: [
    {
      title: "Queue edits locally, flush on connectivity",
      context: "Edits were lost offline.",
      decision: "A local queue table takes every edit; a worker flushes it when online.",
      rationale: "Survives process death.",
      alternatives: "In-memory buffer: rejected.",
      how: "edit → queue row → worker → ack → delete. Last writer wins by server time.",
      consequences: "Per-entity ordering only.",
      touches: [{ kind: "file", ref: "app/sync/Queue.kt" }, { kind: "area", ref: "sync" }],
      supersedes: null,
    },
  ],
  feature: { match: null, name: "Offline sync", aliases: ["background sync"], summary: "Queue + worker.", pitfalls: "Ordering is per entity." },
};

describe("the recorder", () => {
  it("queues a run when it finishes, and writes its decisions once", async () => {
    team();
    aRun("rec-1", "acme-android");
    expect(getExtraction("rec-1")).toMatchObject({ status: "pending", teamId: "acme-android" });

    const provider = new FakeModelProvider(() => ({ text: JSON.stringify(ANSWER), model: "claude-sonnet-5", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 } }));
    const outcome = await extractRun("rec-1", provider, { model: "sonnet" });
    expect(outcome).toEqual({ status: "done", decisionCount: 1 });

    // What the model was shown: the task, the agents' answers, the files.
    const prompt = String(provider.calls[0].messages[0].content);
    expect(prompt).toContain("Add offline sync");
    expect(prompt).toContain("Queue edits locally, flush when online.");
    expect(prompt).toContain("app/sync/Queue.kt");
    expect(prompt).not.toContain("abc123\"");
    expect(provider.calls[0].context).toMatchObject({ executionId: "rec-1", nodeId: "memory-recorder" });

    const [decision] = decisionsForExecution("rec-1");
    expect(decision).toMatchObject({ teamId: "acme-android", userId: "u-1", outcome: "shipped", baseCommit: "abc123", headCommit: "def456", validFrom: 2_000 });
    expect(decision.featureId).toBe("offline-sync");
    expect(getFeature("offline-sync")).toMatchObject({ orgId: "acme", aliases: ["background sync"] });
    expect(implementationsOf(memoryScopeFor("acme-desktop"), "offline-sync")[0]).toMatchObject({ teamId: "acme-android", decisionCount: 1, pitfalls: "Ordering is per entity." });
    expect(getExtraction("rec-1")).toMatchObject({ status: "done", decisionCount: 1, model: "claude-sonnet-5", inputTokens: 1000 });
    expect(getExtraction("rec-1")!.costUsd).toBeGreaterThan(0);

    // A second ask is a no-op: the row is done, the model is not called again.
    expect(await extractRun("rec-1", provider, { model: "sonnet" })).toBeNull();
    expect(provider.calls).toHaveLength(1);

    // And the sibling team finds it by another name.
    expect(searchFeatures(memoryScopeFor("acme-desktop"), "background synchronisation")[0]?.id).toBe("offline-sync");
    expect(searchDecisions(memoryScopeFor("acme-desktop"), { query: "edits lost when offline" })[0]?.executionId).toBe("rec-1");
  });

  it("matches an existing catalogue entry rather than making a twin", async () => {
    team();
    upsertFeature({ orgId: "acme", name: "Login with SSO", aliases: ["single sign-on"], summary: "OIDC." });
    const id = "rec-2";
    const state = createState(id, "dev", { task: "Add single sign-on to the desktop app" });
    createExecution(id, "dev", state.input, 1_000, null, { teamId: "acme-desktop" });
    recordStep(id, { nodeId: "implementer", stepIndex: 0, visit: 1, startedAt: 1, finishedAt: 2, status: "completed", input: {}, output: { summary: "OIDC flow added.", changed: true } });
    state.stepCount = 1;
    state.status = "completed";
    finishExecution(state, null, 3_000);

    const provider = new FakeModelProvider((req) => {
      const prompt = String(req.messages[0].content);
      // The candidate list is what lets it match by id.
      expect(prompt).toContain("login-with-sso: Login with SSO (also: single sign-on)");
      return JSON.stringify({
        decisions: [{ title: "Desktop SSO via system browser", context: "", decision: "Open the system browser for OIDC.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
        feature: { match: "login-with-sso", name: "SSO", aliases: [], summary: "System browser + loopback redirect.", pitfalls: "" },
      });
    });
    expect(await extractRun(id, provider, { model: "sonnet" })).toEqual({ status: "done", decisionCount: 1 });
    expect(decisionsForExecution(id)[0].featureId).toBe("login-with-sso");
    expect(searchFeatures(memoryScopeFor("acme-android"), "sso")[0].teams).toEqual(["acme-desktop"]);
  });

  it("records a stopped run as abandoned, retries a bad answer, and skips a run with nothing in it", async () => {
    team();
    aRun("rec-3", "acme-android", "failed");
    const bad = new FakeModelProvider(() => "I could not decide.");
    expect(await extractRun("rec-3", bad, { model: "sonnet" })).toMatchObject({ status: "failed" });
    expect(getExtraction("rec-3")).toMatchObject({ status: "failed", attempts: 1 });
    expect(getExtraction("rec-3")!.error).toMatch(/shape/);

    const good = new FakeModelProvider(() => JSON.stringify({ decisions: [{ ...ANSWER.decisions[0], title: "Tried a queue; reviewer refused it" }], feature: null }));
    expect(await extractRun("rec-3", good, { model: "sonnet" })).toEqual({ status: "done", decisionCount: 1 });
    expect(decisionsForExecution("rec-3")[0]).toMatchObject({ outcome: "abandoned", featureId: null });

    const empty = "rec-4";
    createExecution(empty, "dev", { task: "x" }, 1_000, null, { teamId: "acme-android", driver: "session", origin: "local" });
    expect(stopSessionExecution(empty, 1_500)).toBe(true);
    expect(getExtraction(empty)).toMatchObject({ status: "pending" });
    expect(await extractRun(empty, good, { model: "sonnet" })).toMatchObject({ status: "skipped" });
    expect(good.calls).toHaveLength(1);
  });

  it("drains whatever is waiting, one pass at a time", async () => {
    team();
    aRun("rec-5", "acme-desktop");
    aRun("rec-6", "acme-desktop");
    const provider = new FakeModelProvider(() => JSON.stringify({ decisions: [], feature: null }));
    const done = await drainExtractions(provider);
    expect(done).toBeGreaterThanOrEqual(2);
    expect(getExtraction("rec-5")).toMatchObject({ status: "done", decisionCount: 0 });
    expect(getExtraction("rec-6")).toMatchObject({ status: "done", decisionCount: 0 });
    expect(await drainExtractions(provider)).toBe(0);
  });
});

describe("reading a run", () => {
  it("takes the answer out of prose or a fence, and the paths out of a diff", () => {
    expect(parseRecorderAnswer('Here you go:\n```json\n{"decisions":[],"feature":null}\n```').decisions).toEqual([]);
    expect(parseRecorderAnswer('{"decisions":[{"title":"t"}]}').decisions[0]).toMatchObject({ title: "t", touches: [] });
    expect(() => parseRecorderAnswer("nope")).toThrow(/shape/);
    expect(pathsInDiff("diff --git a/src/a.ts b/src/a.ts\n--- a\n+++ b\ndiff --git a/README.md b/README.md\n")).toEqual(["src/a.ts", "README.md"]);
    expect(readableSteps([{ output: { stdout: "x" } } as never, { output: { plan: "p" } } as never, { output: null } as never])).toHaveLength(1);
  });
});

describe("runs from before memory existed", () => {
  it("are queued on request, and one can be asked for from its page", () => {
    team();
    aRun("old-1", "acme-android");
    aRun("old-2", "acme-android");
    // The ledger rows a finish writes, taken away: these runs predate memory.
    getDb().prepare("DELETE FROM memory_extractions WHERE execution_id IN ('old-1', 'old-2')").run();
    expect(getExtraction("old-1")).toBeNull();
    expect(requeueExtraction("old-1")).toBe(true);
    expect(getExtraction("old-1")).toMatchObject({ status: "pending", teamId: "acme-android" });
    expect(queueUnrecordedExecutions(memoryScopeFor("acme-desktop").teams)).toBe(1);
    expect(getExtraction("old-2")).toMatchObject({ status: "pending" });
    expect(queueUnrecordedExecutions(memoryScopeFor("acme-desktop").teams)).toBe(0);
    expect(requeueExtraction("never-ran")).toBe(false);
  });
});
