import { describe, expect, it } from "vitest";

import { createExecution, finishExecution, recordStep, setExecutionDiff } from "@/executions/store";
import type { ExecutionRecord } from "@/executions/types";
import { createTeam, getTeam } from "@/lib/teams";
import { toDecisionCard, describeDecision } from "@/memory/cards";
import { designSlug, extractRun, outcomeOf, ownerTeamOf, parseRecorderAnswer, RECORDER_SYSTEM } from "@/memory/extract";
import { decisionsForExecution, getFeature, implementationsOf, memoryScopeFor, replaceDecisions, toMatchQuery } from "@/memory/store";
import { MERGE_WORKFLOW_ID } from "@/memory/types";
import { createRepo } from "@/repos/store";
import { createState } from "@/runtime/state";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/**
 * Two things the record used to say wrong.
 *
 * A run that stopped — a timeout, a flaky check, a person going home — was
 * recorded "abandoned" and recall read that as a road already found closed,
 * so a good idea was avoided because its run did not finish. Refusal is now
 * a verdict of its own.
 *
 * A decision was filed under the team of whoever ran it, so work a desktop
 * person did in the server's repository became desktop's record: the server
 * team could not supersede it, objections went to the wrong team, and the
 * server's page on the feature never heard of it.
 */

function tree() {
  if (!getTeam("vo-ulak")) {
    createTeam("VO Ulak", "vo-ulak");
    createTeam("VO Server", "vo-server", "vo-ulak");
    createTeam("VO Desktop", "vo-desktop", "vo-ulak");
    createTeam("VO Other", "vo-other");
  }
}

const SERVER_REPO = "github.com/ulak/vo-server";

function serverRepo() {
  tree();
  if (!ownerTeamOf({ teamId: "vo-desktop", repoId: SERVER_REPO }).startsWith("vo-server")) {
    createRepo({
      id: "vo-server-repo",
      name: "server",
      source: "/tmp/vo-server",
      root: "/tmp/vo-server",
      remoteUrl: `git@github.com:ulak/vo-server.git`,
      cloned: false,
      baseRef: "main",
      setup: [],
      prepare: [],
      teamId: "vo-server",
    });
  }
}

function aRun(id: string, teamId: string, opts: { status?: "completed" | "failed"; repoId?: string | null; diff?: string } = {}) {
  const state = createState(id, "dev", { task: "Batch the sync endpoint so clients send many edits at once" });
  createExecution(id, "dev", state.input, 1_000, null, { teamId, userId: null, repoId: opts.repoId ?? null });
  recordStep(id, {
    nodeId: "planner", stepIndex: 0, visit: 1, startedAt: 1_000, finishedAt: 1_100, status: "completed", input: {},
    output: { plan: "Accept an array on POST /v1/sync.", planFile: "docs/plans/sync.md", questions: "", notes: "" },
  });
  state.stepCount = 1;
  state.status = opts.status ?? "completed";
  finishExecution(state, { root: "/tmp/x", repo: "/tmp/r", branch: "gate/sync", baseRef: "main", baseCommit: "a1", commit: "b2", changedFiles: ["api/sync.go"] }, 2_000);
  if (opts.diff) setExecutionDiff(id, opts.diff);
}

function answer(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    decisions: [
      { title: "Accept a batch on the sync endpoint", context: "", decision: "An array of edits per request.", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "file", ref: "api/sync.go" }] },
      {
        title: "Stream edits over a websocket",
        context: "",
        decision: "Tried a socket per client.",
        rationale: "",
        alternatives: "",
        how: "",
        consequences: "The reviewer refused it: the load balancer drops idle sockets.",
        touches: [{ kind: "file", ref: "api/ws.go" }],
        verdict: "rejected",
        verdictReason: "reviewer: the load balancer drops idle sockets",
      },
    ],
    feature: { match: null, name: "Batched sync", aliases: [], description: "Clients send many edits at once.", summary: "Array per request.", pitfalls: "" },
    ...extra,
  });
}

const provider = (text: string) => new FakeModelProvider(() => ({ text, model: "claude-sonnet-5", usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } }));

describe("a refusal is a verdict, not an outcome", () => {
  it("keeps only an explicit refusal, whatever else the model writes there", () => {
    const parsed = parseRecorderAnswer(
      JSON.stringify({
        decisions: [
          { title: "a", verdict: "rejected", verdictReason: "reviewer said no" },
          { title: "b", verdict: "stopped" },
          { title: "c", verdict: null },
          { title: "d" },
        ],
      }),
    );
    expect(parsed.decisions.map((d) => d.verdict)).toEqual(["rejected", null, null, null]);
    expect(RECORDER_SYSTEM).toContain('"verdict" is "rejected" only when the approach itself was refused');
  });

  it("records an unfinished run's decisions as abandoned, and only the refused one as refused", async () => {
    tree();
    aRun("vo-stopped", "vo-desktop", { status: "failed" });
    await extractRun("vo-stopped", provider(answer()), { model: "sonnet" });
    const [kept, refused] = decisionsForExecution("vo-stopped");
    expect(kept).toMatchObject({ outcome: "abandoned", verdict: null });
    expect(refused).toMatchObject({ outcome: "abandoned", verdict: "rejected", verdictReason: "reviewer: the load balancer drops idle sockets" });

    // What recall reads: the unfinished one says it is not a refusal; the
    // refused one says it is a closed road, and why.
    expect(describeDecision(toDecisionCard(kept))).toContain("abandoned (the run did not finish — not a refusal)");
    expect(describeDecision(toDecisionCard(refused))).toContain("✗ refused: reviewer: the load balancer drops idle sockets");
  });

  it("drops a reason given without a refusal", () => {
    const [d] = replaceDecisions(
      { executionId: "vo-reason", teamId: "vo-desktop", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "completed", validFrom: 1 },
      [{ title: "t", context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [], verdict: null, verdictReason: "nobody refused anything" }],
    );
    expect(d.verdictReason).toBeNull();
  });
});

describe("a decision belongs to the repository's team", () => {
  it("files work in the server's repository under the server, with the desktop run as its author", async () => {
    serverRepo();
    expect(ownerTeamOf({ teamId: "vo-desktop", repoId: SERVER_REPO })).toBe("vo-server");
    aRun("vo-cross", "vo-desktop", { repoId: SERVER_REPO });
    await extractRun("vo-cross", provider(answer()), { model: "sonnet" });
    const [d] = decisionsForExecution("vo-cross");
    expect(d).toMatchObject({ teamId: "vo-server", authorTeamId: "vo-desktop" });
    // The server's page on the feature is the one that learned of it.
    expect(implementationsOf(memoryScopeFor("vo-server"), d.featureId!).map((i) => i.teamId)).toEqual(["vo-server"]);
    expect(describeDecision(toDecisionCard(d))).toContain("team: vo-server (made by vo-desktop)");
  });

  it("keeps the run's own team when the repository has none, or is outside the run's tree", () => {
    tree();
    expect(ownerTeamOf({ teamId: "vo-desktop", repoId: null })).toBe("vo-desktop");
    expect(ownerTeamOf({ teamId: "vo-desktop", repoId: "github.com/nobody/unknown" })).toBe("vo-desktop");
    serverRepo();
    // Another company's run in a repository of this tree does not make its decision this tree's.
    expect(ownerTeamOf({ teamId: "vo-other", repoId: SERVER_REPO })).toBe("vo-other");
  });

  it("does not write an author when the owner ran it", async () => {
    tree();
    aRun("vo-own", "vo-desktop");
    await extractRun("vo-own", provider(answer()), { model: "sonnet" });
    expect(decisionsForExecution("vo-own")[0].authorTeamId).toBeNull();
  });
});

describe("a design doc names its feature", () => {
  it("reads the feature's id from the file name", () => {
    expect(designSlug("docs/design/offline-sync.md")).toBe("offline-sync");
    expect(designSlug("docs/decisions/0001-x.md")).toBeNull();
    expect(designSlug("docs/design/sub/x.md")).toBeNull();
  });

  it("files a run that wrote one design doc under that feature, over the model's own name for it", async () => {
    tree();
    const diff = [
      "diff --git a/docs/design/batched-sync.md b/docs/design/batched-sync.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/design/batched-sync.md",
      "@@ -0,0 +1,3 @@",
      "+# Batched sync",
      "+",
      "+## Summary",
    ].join("\n");
    aRun("vo-design", "vo-desktop", { diff });
    await extractRun("vo-design", provider(answer({ feature: { match: null, name: "Bulk edit upload", aliases: ["bulk"], description: "d", summary: "s", pitfalls: "" } })), {
      model: "sonnet",
    });
    expect(decisionsForExecution("vo-design")[0].featureId).toBe("batched-sync");
    expect(getFeature("batched-sync")?.orgId).toBe("vo-ulak");
  });
});

describe("a merge found on the base branch", () => {
  it("is merged: gate saw it land", () => {
    expect(outcomeOf({ status: "completed", workflowId: MERGE_WORKFLOW_ID, input: {} } as ExecutionRecord, [])).toBe("merged");
  });
});

describe("searching in another language", () => {
  it("reaches a Turkish root through its suffix", () => {
    // Porter stems English only; a long word also asks for its first part.
    expect(toMatchQuery("bildirimleri")).toContain('"bildirim"*');
    expect(toMatchQuery("senkronizasyonu")).toContain('"senkronizas"*');
    expect(toMatchQuery("sync")).toBe('"sync"*');
  });
});
