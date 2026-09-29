import { describe, expect, it } from "vitest";

import { createExecution } from "@/executions/store";
import { forgetDecision } from "@/memory/forget";
import { insertIssue, liveIssues } from "@/memory/issues";
import { getDb } from "@/lib/db";
import { createTeam, deleteTeam, setTeamParent, teamAncestors, teamFamily, teamPath, teamRoot, teamTree } from "@/lib/teams";
import {
  claimExtraction,
  decisionsForExecution,
  getDecision,
  implementationsOf,
  listFeatures,
  memoryScopeFor,
  pendingExtractions,
  queueExtraction,
  replaceDecisions,
  requeueExtraction,
  retractDecision,
  searchDecisions,
  searchFeatures,
  settleExtraction,
  toMatchQuery,
  upsertFeature,
  upsertImplementation,
} from "@/memory/store";

/**
 * The memory layer, from the outside: a tree of teams, what each may read,
 * and that a run is recorded once.
 */

function tree() {
  if (!teamAncestors("ulak").length) {
    createTeam("Ulak", "ulak");
    createTeam("Android", "android", "ulak");
    createTeam("Desktop", "desktop", "ulak");
    createTeam("Other Co", "otherco");
  }
}

describe("teams as a tree", () => {
  it("knows who sits under whom", () => {
    tree();
    expect(teamRoot("android")).toBe("ulak");
    expect(teamRoot("ulak")).toBe("ulak");
    expect(teamPath("android")).toBe("ulak/android");
    expect(teamTree("ulak").sort()).toEqual(["android", "desktop", "ulak"]);
    expect(teamFamily("desktop").sort()).toEqual(["android", "desktop", "ulak"]);
    expect(teamFamily("otherco")).toEqual(["otherco"]);
  });

  it("refuses a loop and a delete that would orphan teams", () => {
    tree();
    expect(() => setTeamParent("ulak", "android")).toThrow(/loop/);
    expect(() => setTeamParent("ulak", "ulak")).toThrow(/itself/);
    expect(() => deleteTeam("ulak")).toThrow(/under it/);
    createTeam("Web", "web", "ulak");
    setTeamParent("web", null);
    expect(teamRoot("web")).toBe("web");
    expect(deleteTeam("web")).toBe(true);
  });
});

describe("free text as a query", () => {
  it("quotes every word, so the user's punctuation is never syntax", () => {
    expect(toMatchQuery("offline sync: retry-with backoff")).toBe('"offline"* OR "sync"* OR "retry"* OR "backoff"*');
    expect(toMatchQuery("the and for")).toBeNull();
    expect(toMatchQuery("db")).toBe('"db"');
  });
});

describe("decisions in a scope", () => {
  const android = () => memoryScopeFor("android");
  const desktop = () => memoryScopeFor("desktop");
  const other = () => memoryScopeFor("otherco");

  function seed() {
    tree();
    if (decisionsForExecution("run-android-1").length) return;
    const feature = upsertFeature({ orgId: "ulak", name: "Offline sync", aliases: ["background sync"], summary: "Keeps local edits and pushes them when online." });
    replaceDecisions(
      { executionId: "run-android-1", teamId: "android", userId: "u1", featureId: feature.id, repoId: null, baseCommit: "aaa", headCommit: "bbb", outcome: "shipped", validFrom: 1_000 },
      [
        {
          title: "Queue edits in Room, flush on connectivity",
          context: "Edits were lost when the app went offline.",
          decision: "Every edit goes into a local queue table first; a worker flushes it when the network is back.",
          rationale: "A queue survives process death; an in-memory buffer does not.",
          alternatives: "Retrying in place — rejected, blocks the UI.",
          how: "Edit → queue row (pending) → WorkManager job → server ack → row deleted. Conflicts: last-writer-wins by server timestamp.",
          consequences: "Order of edits is per-entity, not global.",
          touches: [
            { kind: "file", ref: "app/src/main/java/sync/SyncQueue.kt" },
            { kind: "area", ref: "sync" },
          ],
        },
      ],
      1_100,
    );
    upsertImplementation({ featureId: feature.id, teamId: "android", summary: "Room queue + WorkManager flush.", pitfalls: "Per-entity ordering only." });
    replaceDecisions(
      { executionId: "run-other-1", teamId: "otherco", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [{ title: "Offline sync via CRDT", context: "", decision: "CRDT merge", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
      1_100,
    );
  }

  it("finds a sibling team's decision by text, and not another tree's", () => {
    seed();
    const hits = searchDecisions(desktop(), { query: "how did we do offline synchronisation with a queue" });
    expect(hits.map((h) => h.executionId)).toEqual(["run-android-1"]);
    expect(hits[0].teamId).toBe("android");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(searchDecisions(other(), { query: "offline sync" }).map((h) => h.executionId)).toEqual(["run-other-1"]);
  });

  it("finds decisions by the paths they touched", () => {
    seed();
    expect(searchDecisions(android(), { paths: ["app/src/main/java/sync"] }).map((h) => h.executionId)).toEqual(["run-android-1"]);
    expect(searchDecisions(android(), { paths: ["app/src/main/java/ui"] })).toEqual([]);
    expect(searchDecisions(android(), { paths: ["./app/src/main/java/sync/SyncQueue.kt"] })).toHaveLength(1);
  });

  it("matches the catalogue by an alias", () => {
    seed();
    const features = searchFeatures(desktop(), "background sync");
    expect(features[0]?.name).toBe("Offline sync");
    expect(features[0].teams).toEqual(["android"]);
    expect(implementationsOf(desktop(), features[0].id)[0]).toMatchObject({ teamId: "android", pitfalls: "Per-entity ordering only." });
    expect(searchFeatures(other(), "offline sync")).toEqual([]);
  });

  it("closes a superseded decision and keeps it for the past", () => {
    seed();
    const [old] = decisionsForExecution("run-android-1");
    replaceDecisions(
      { executionId: "run-android-2", teamId: "android", userId: "u1", featureId: old.featureId, repoId: null, baseCommit: "bbb", headCommit: "ccc", outcome: "shipped", validFrom: 5_000 },
      [{ title: "Flush the sync queue on a timer too", context: "", decision: "Timer + connectivity", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "sync" }], supersedes: old.id }],
      5_100,
    );
    expect(getDecision(old.id)!.validTo).toBe(5_000);
    expect(searchDecisions(android(), { paths: ["sync"], asOf: 2_000 }).map((h) => h.executionId)).toEqual(["run-android-1"]);
    expect(searchDecisions(android(), { paths: ["sync"], asOf: 6_000 }).map((h) => h.executionId)).toEqual(["run-android-2"]);
  });

  it("will not let one team close another's decision, even inside the family", () => {
    seed();
    replaceDecisions(
      { executionId: "run-android-9", teamId: "android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 7_000 },
      [{ title: "Encode envelopes with protobuf", context: "", decision: "protobuf", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "envelope" }] }],
      7_100,
    );
    const [theirs] = decisionsForExecution("run-android-9");
    replaceDecisions(
      { executionId: "run-desktop-9", teamId: "desktop", userId: "u1", featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 8_000 },
      [{ title: "Encode envelopes with JSON", context: "", decision: "json", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "envelope" }], supersedes: theirs.id }],
      8_100,
    );
    // The desktop run reads android's decision — that is what the family scope
    // is for — but the link is refused and android's decision still holds.
    expect(decisionsForExecution("run-desktop-9")[0].supersedes).toBeNull();
    expect(getDecision(theirs.id)!.validTo).toBeNull();
    // Both still hold: the disagreement is visible to the family rather than
    // settled by whoever recorded last.
    expect(searchDecisions(android(), { paths: ["envelope"], asOf: 9_000 }).map((h) => h.executionId).sort()).toEqual([
      "run-android-9",
      "run-desktop-9",
    ]);
  });

  it("still lets a team supersede its own decision from a later run", () => {
    seed();
    replaceDecisions(
      { executionId: "run-desktop-10", teamId: "desktop", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 7_000 },
      [{ title: "Poll the desktop inbox", context: "", decision: "poll", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "inbox" }] }],
      7_100,
    );
    const [mine] = decisionsForExecution("run-desktop-10");
    replaceDecisions(
      { executionId: "run-desktop-11", teamId: "desktop", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 8_000 },
      [{ title: "Push to the desktop inbox", context: "", decision: "push", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "inbox" }], supersedes: mine.id }],
      8_100,
    );
    expect(decisionsForExecution("run-desktop-11")[0].supersedes).toBe(mine.id);
    expect(getDecision(mine.id)!.validTo).toBe(8_000);
  });

  it("rewrites a run's record whole, and a retraction hides it", () => {
    seed();
    replaceDecisions(
      { executionId: "run-android-2", teamId: "android", userId: "u1", featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "abandoned", validFrom: 5_000 },
      [
        { title: "Alpha retry policy", context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
        { title: "Bravo retry policy", context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
      ],
    );
    const now = decisionsForExecution("run-android-2");
    expect(now.map((d) => d.title)).toEqual(["Alpha retry policy", "Bravo retry policy"]);
    expect(now[0].outcome).toBe("abandoned");
    expect(retractDecision(now[0].id)).toBe(true);
    expect(searchDecisions(android(), { query: "retry policy" }).map((d) => d.title)).toEqual(["Bravo retry policy"]);
    expect(searchDecisions(android(), { query: "retry policy", includeRetracted: true })).toHaveLength(2);
  });
});

describe("the extraction ledger", () => {
  it("records a run once, retries a failure, and stops after enough of them", () => {
    tree();
    // A run that has ended; a requeue is refused for one still going or unknown.
    createExecution("run-x", "dev", {}, 1, null, { teamId: "android" });
    getDb().prepare("UPDATE workflow_executions SET status = 'completed', finished_at = 2 WHERE id = 'run-x'").run();
    queueExtraction("run-x", "android", 10);
    queueExtraction("run-x", "android", 20);
    expect(pendingExtractions().map((e) => e.executionId)).toContain("run-x");
    expect(claimExtraction("run-x")).toBe(true);
    expect(claimExtraction("run-x")).toBe(false);
    settleExtraction("run-x", { status: "failed", error: "model down" });
    expect(claimExtraction("run-x")).toBe(true);
    settleExtraction("run-x", { status: "failed", error: "model down" });
    expect(claimExtraction("run-x")).toBe(true);
    settleExtraction("run-x", { status: "failed", error: "model down" });
    expect(claimExtraction("run-x")).toBe(false);
    expect(pendingExtractions().map((e) => e.executionId)).not.toContain("run-x");
    expect(requeueExtraction("run-x")).toBe(true);
    expect(claimExtraction("run-x")).toBe(true);
    settleExtraction("run-x", { status: "done", decisionCount: 2, model: "claude-sonnet-5", costUsd: 0.01 });
    expect(claimExtraction("run-x")).toBe(false);
  });
});

describe("recording a run again", () => {
  const base = (executionId: string, validFrom: number) => ({
    executionId,
    teamId: "android",
    userId: null,
    featureId: null,
    repoId: null,
    baseCommit: null,
    headCommit: null,
    outcome: "merged" as const,
    validFrom,
  });
  const d = (title: string, supersedes?: string) => ({ title, context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [], ...(supersedes ? { supersedes } : {}) });

  it("reopens what an old decision closed when the new record has no such decision", () => {
    tree();
    const [polling] = replaceDecisions(base("rr-old-1", 500), [d("Use polling")]);
    replaceDecisions(base("rr-new-1", 1_000), [d("Use push", polling.id)]);
    expect(getDecision(polling.id)!.validTo).toBe(1_000);
    // Read again, the run is about something else entirely.
    replaceDecisions(base("rr-new-1", 1_000), [d("Rename the settings screen")]);
    expect(getDecision(polling.id)!.validTo).toBeNull();
  });

  it("moves what pointed at an old decision to the same decision read again", () => {
    tree();
    const [polling] = replaceDecisions(base("rr-old-2", 500), [d("Use polling v2")]);
    const [push] = replaceDecisions(base("rr-new-2", 1_000), [d("Use push v2", polling.id)]);
    // A later run closed it, and another team objects to it.
    const [later] = replaceDecisions(base("rr-later-2", 2_000), [d("Use push with batching", push.id)]);
    expect(getDecision(push.id)!.validTo).toBe(2_000);
    createExecution("rr-objector-2", "dev", {}, 1, null, { teamId: "desktop" });
    insertIssue({ executionId: "rr-objector-2", stepIndex: 0, sourceNodeId: "planner", sourceVisit: 1, conflictKey: "k", fromTeamId: "desktop", targetTeamId: "android", decisionId: push.id, title: "push breaks desktop" });
    getDb().prepare("UPDATE decision_issues SET status = 'open' WHERE decision_id = ?").run(push.id);

    // Read again, and this time the recorder does not name what it superseded.
    const [pushAgain] = replaceDecisions(base("rr-new-2", 1_000), [d("Use push v2")]);
    // What it closed stays closed and is named, so forgetting it can undo it.
    expect(pushAgain.supersedes).toBe(polling.id);
    expect(getDecision(polling.id)!.validTo).toBe(1_000);
    // The later decision's closing and pointer, and the objection, follow it.
    expect(getDecision(pushAgain.id)!.validTo).toBe(2_000);
    expect(getDecision(later.id)!.supersedes).toBe(pushAgain.id);
    expect(liveIssues(memoryScopeFor("android"), { decisionIds: [pushAgain.id] })).toHaveLength(1);

    forgetDecision(pushAgain.id);
    expect(getDecision(polling.id)!.validTo).toBeNull();
  });
});

describe("a feature's teams", () => {
  it("names only teams of the feature's own tree", () => {
    tree();
    const f = upsertFeature({ orgId: "ulak", name: "Offline sync teams" });
    upsertImplementation({ featureId: f.id, teamId: "android", summary: "" });
    // A row for a team of another tree: a design doc of the same file name
    // in another company's repository reads the same way.
    upsertImplementation({ featureId: f.id, teamId: "otherco", summary: "" });
    const mine = listFeatures(memoryScopeFor("desktop")).find((x) => x.id === f.id)!;
    expect(mine.teams).toEqual(["android"]);
  });
});

describe("words with a capital dotted İ", () => {
  it("finds what the lowercase word finds", () => {
    tree();
    createExecution("tr-1", "dev", {}, 1, null, { teamId: "android" });
    replaceDecisions(
      { executionId: "tr-1", teamId: "android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "merged", validFrom: 1 },
      [{ title: "İptal akışı sunucuda doğrulanır", context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
    );
    const scope = memoryScopeFor("android");
    expect(searchDecisions(scope, { query: "iptal" }).length).toBe(1);
    expect(searchDecisions(scope, { query: "İptal" }).length).toBe(1);
    upsertFeature({ orgId: "ulak", name: "İndirme yöneticisi" });
    expect(searchFeatures(scope, "İndirme").length).toBe(1);
  });
});
