import { describe, expect, it } from "vitest";

import { DELETE as forgetRunMemoryRoute } from "@/app/api/executions/[id]/memory/route";
import { DELETE as forgetDecisionRoute } from "@/app/api/memory/decisions/[id]/route";
import { DELETE as forgetFeatureRoute } from "@/app/api/memory/features/[id]/route";
import { createExecution } from "@/executions/store";
import { getDb } from "@/lib/db";
import { createTeam, teamAncestors } from "@/lib/teams";
import { forgetDecision, forgetFeature, forgetRunMemory } from "@/memory/forget";
import {
  decisionsForExecution,
  getDecision,
  getExtraction,
  getFeature,
  implementationsOf,
  memoryScopeFor,
  queueExtraction,
  queueUnrecordedExecutions,
  replaceDecisions,
  requeueExtraction,
  searchDecisions,
  searchFeatures,
  settleExtraction,
  upsertFeature,
  upsertImplementation,
} from "@/memory/store";

/**
 * Forgetting: a record deleted takes with it everything that pointed at it —
 * the text index, the paths, the counts, the pointers — and does not come
 * back on its own.
 */

function tree() {
  if (!teamAncestors("forget-android").length) {
    createTeam("Forget Co", "forgetco");
    createTeam("Android", "forget-android", "forgetco");
    createTeam("Other Co", "forget-other");
  }
}

/** A finished run of `forget-android`, so the ledger has something to talk about. */
function aRun(id: string): string {
  if (!getDb().prepare("SELECT 1 FROM workflow_executions WHERE id = ?").get(id)) {
    createExecution(id, "dev", {}, 1, null, { teamId: "forget-android" });
    getDb().prepare("UPDATE workflow_executions SET status = 'completed', finished_at = 2 WHERE id = ?").run(id);
  }
  return id;
}

const draft = (title: string, refs: string[] = []) => ({
  title,
  context: "",
  decision: "",
  rationale: "",
  alternatives: "",
  how: "",
  consequences: "",
  touches: refs.map((ref) => ({ kind: "file" as const, ref })),
});

describe("forgetting one decision", () => {
  it("takes its text, its paths, its count and the pointers at it", () => {
    tree();
    const scope = memoryScopeFor("forget-android");
    const feature = upsertFeature({ orgId: "forgetco", name: "Push notifications", summary: "Delivers alerts." });
    const [keep, drop] = replaceDecisions(
      { executionId: aRun("forget-run-1"), teamId: "forget-android", userId: "u1", featureId: feature.id, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Batch alerts per device", ["src/push/batch.ts"]), draft("Retry a failed push twice", ["src/push/retry.ts"])],
      1_100,
    );
    upsertImplementation({ featureId: feature.id, teamId: "forget-android", summary: "FCM with a retry." });
    expect(implementationsOf(scope, feature.id)[0].decisionCount).toBe(2);

    expect(forgetDecision(drop.id)).toBe(true);

    expect(getDecision(drop.id)).toBeNull();
    expect(searchDecisions(scope, { query: "twice" }).map((d) => d.id)).toEqual([]);
    expect(searchDecisions(scope, { paths: ["src/push/retry.ts"] })).toEqual([]);
    // The one beside it is untouched, by words and by path.
    expect(searchDecisions(scope, { query: "batch alerts" }).map((d) => d.id)).toEqual([keep.id]);
    expect(searchDecisions(scope, { paths: ["src/push"] }).map((d) => d.id)).toEqual([keep.id]);
    expect(implementationsOf(scope, feature.id)[0].decisionCount).toBe(1);
    // Nothing left in the touches index either.
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM memory_touches WHERE decision_id = ?").get(drop.id)).toEqual({ n: 0 });
    expect(forgetDecision(drop.id)).toBe(false);
  });

  it("lets the decision it had closed hold again", () => {
    tree();
    const scope = memoryScopeFor("forget-android");
    const [old] = replaceDecisions(
      { executionId: aRun("forget-run-2"), teamId: "forget-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Poll the inbox every minute", ["src/inbox/poll.ts"])],
      1_100,
    );
    const [newer] = replaceDecisions(
      { executionId: aRun("forget-run-3"), teamId: "forget-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 5_000 },
      [{ ...draft("Push instead of polling the inbox", ["src/inbox/push.ts"]), supersedes: old.id }],
      5_100,
    );
    expect(getDecision(old.id)!.validTo).toBe(5_000);

    expect(forgetDecision(newer.id)).toBe(true);

    expect(getDecision(old.id)!.validTo).toBeNull();
    expect(searchDecisions(scope, { paths: ["src/inbox"], asOf: 9_000 }).map((d) => d.id)).toEqual([old.id]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM memory_decisions WHERE supersedes = ?").get(newer.id)).toEqual({ n: 0 });
  });
});

describe("forgetting what a run taught", () => {
  it("deletes its decisions and leaves the ledger saying so", () => {
    tree();
    const scope = memoryScopeFor("forget-android");
    const id = aRun("forget-run-4");
    replaceDecisions(
      { executionId: id, teamId: "forget-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Cache the avatar bitmaps", ["src/ui/avatar.ts"]), draft("Evict the avatar cache on logout", ["src/ui/avatar.ts"])],
      1_100,
    );
    queueExtraction(id, "forget-android", 10);
    settleExtraction(id, { status: "done", decisionCount: 2, model: "claude-sonnet-5", costUsd: 0.02 });

    expect(forgetRunMemory(id, 7_000)).toMatchObject({ decisions: 2 });

    expect(decisionsForExecution(id)).toEqual([]);
    expect(searchDecisions(scope, { query: "avatar bitmaps" })).toEqual([]);
    expect(getExtraction(id)).toMatchObject({ status: "skipped", error: "forgotten on request", decisionCount: 0, finishedAt: 7_000 });
    // The run itself is still there, with its steps and its diff.
    expect(getDb().prepare("SELECT status FROM workflow_executions WHERE id = ?").get(id)).toEqual({ status: "completed" });
    // "Record earlier runs" passes it by; asking for it again is deliberate.
    queueUnrecordedExecutions(["forget-android"]);
    expect(getExtraction(id)!.status).toBe("skipped");
    expect(requeueExtraction(id)).toBe(true);
    expect(getExtraction(id)!.status).toBe("pending");
  });

  it("writes a ledger row for decisions that never had one", () => {
    tree();
    const id = aRun("forget-run-5");
    replaceDecisions(
      { executionId: id, teamId: "forget-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Sign uploads with a short-lived token", ["src/upload/sign.ts"])],
      1_100,
    );
    expect(getExtraction(id)).toBeNull();

    forgetRunMemory(id, 8_000);

    expect(getExtraction(id)).toMatchObject({ status: "skipped", error: "forgotten on request" });
    queueUnrecordedExecutions(["forget-android"]);
    expect(getExtraction(id)!.status).toBe("skipped");
  });

  it("answers the run page with the panel's new state", async () => {
    tree();
    const id = aRun("forget-run-9");
    replaceDecisions(
      { executionId: id, teamId: "forget-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Resize photos before upload", ["src/upload/resize.ts"])],
      1_100,
    );
    queueExtraction(id, "forget-android", 10);
    settleExtraction(id, { status: "done", decisionCount: 1 });

    const res = await forgetRunMemoryRoute(new Request("http://gate.test/x", { method: "DELETE" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forgotten).toMatchObject({ decisions: 1 });
    expect(body.decisions).toEqual([]);
    expect(body.extraction).toMatchObject({ status: "skipped", error: "forgotten on request" });

    const missing = await forgetRunMemoryRoute(new Request("http://gate.test/x", { method: "DELETE" }), { params: Promise.resolve({ id: "no-such-run" }) });
    expect(missing.status).toBe(404);
  });
});

describe("forgetting a feature", () => {
  it("takes its pages, its history and the decisions filed under it", () => {
    tree();
    const scope = memoryScopeFor("forget-android");
    const feature = upsertFeature({ orgId: "forgetco", name: "Offline drafts", aliases: ["draft cache"], summary: "Keeps unsent drafts." });
    const other = upsertFeature({ orgId: "forgetco", name: "Search bar", summary: "Finds a chat by name." });
    const run = aRun("forget-run-6");
    replaceDecisions(
      { executionId: run, teamId: "forget-android", userId: null, featureId: feature.id, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Store drafts in SQLite", ["src/drafts/store.ts"]), draft("Drop a draft once it sends", ["src/drafts/send.ts"])],
      1_100,
    );
    const kept = replaceDecisions(
      { executionId: aRun("forget-run-7"), teamId: "forget-android", userId: null, featureId: other.id, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Rank chats by last message", ["src/search/rank.ts"])],
      1_100,
    )[0];
    upsertImplementation({ featureId: feature.id, teamId: "forget-android", summary: "SQLite drafts table." });
    getDb()
      .prepare("INSERT INTO memory_consolidations (feature_id, team_id, status, started_at, decisions_read) VALUES (?,?,?,?,?)")
      .run(feature.id, "forget-android", "done", 2_000, 2);

    expect(forgetFeature(feature.id, 9_000)).toMatchObject({ decisions: 2, features: 1, implementations: 1, consolidations: 1 });

    expect(getFeature(feature.id)).toBeNull();
    expect(searchFeatures(scope, "draft cache")).toEqual([]);
    expect(searchDecisions(scope, { query: "drafts in SQLite" })).toEqual([]);
    expect(searchDecisions(scope, { paths: ["src/drafts"] })).toEqual([]);
    expect(decisionsForExecution(run)).toEqual([]);
    expect(getExtraction(run)).toMatchObject({ status: "skipped", error: "forgotten on request" });
    // The feature beside it, and its decision, are untouched.
    expect(getFeature(other.id)).not.toBeNull();
    expect(searchDecisions(scope, { featureId: other.id }).map((d) => d.id)).toEqual([kept.id]);
  });
});

describe("the boundary a forget may not cross", () => {
  it("refuses a record from another tree, and deletes nothing", async () => {
    tree();
    const feature = upsertFeature({ orgId: "forgetco", name: "Two-factor login", summary: "TOTP at sign-in." });
    const [decision] = replaceDecisions(
      { executionId: aRun("forget-run-8"), teamId: "forget-android", userId: null, featureId: feature.id, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
      [draft("Verify TOTP server-side", ["src/auth/totp.ts"])],
      1_100,
    );

    const asOther = (path: string) => new Request(`http://gate.test${path}?team=forget-other`, { method: "DELETE" });
    const d = await forgetDecisionRoute(asOther("/api/memory/decisions"), { params: Promise.resolve({ id: decision.id }) });
    expect(d.status).toBe(403);
    const f = await forgetFeatureRoute(asOther("/api/memory/features"), { params: Promise.resolve({ id: feature.id }) });
    expect(f.status).toBe(403);
    expect(getDecision(decision.id)).not.toBeNull();
    expect(getFeature(feature.id)).not.toBeNull();

    // Unknown ids are a 404, not a silent success.
    const missing = await forgetDecisionRoute(asOther("/api/memory/decisions"), { params: Promise.resolve({ id: "no-such-decision" }) });
    expect(missing.status).toBe(404);

    // Its own tree may.
    const mine = new Request("http://gate.test/api/memory/decisions?team=forget-android", { method: "DELETE" });
    const ok = await forgetDecisionRoute(mine, { params: Promise.resolve({ id: decision.id }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ forgotten: true });
    expect(getDecision(decision.id)).toBeNull();
  });
});
