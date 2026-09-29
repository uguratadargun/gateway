import { describe, expect, it } from "vitest";

import { createTeam, getTeam } from "@/lib/teams";
import { consolidateImplementation, consolidationsOf, dueConsolidations, parseConsolidatorAnswer } from "@/memory/consolidate";
import { getDecision, getImplementation, memoryScopeFor, replaceDecisions, searchDecisions, upsertFeature, upsertImplementation } from "@/memory/store";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/**
 * The consolidation pass: a team's page on a feature rewritten from all its
 * decisions, older ones closed when a later one replaced them — and never a
 * closure the decisions do not support.
 */

function seed() {
  if (getTeam("co-org")) return;
  createTeam("Consolidate org", "co-org");
  createTeam("Consolidate android", "co-android", "co-org");
  createTeam("Consolidate other", "co-other");
  upsertFeature({ orgId: "co-org", name: "Offline sync", aliases: [], summary: "Edits survive losing the network." });
  const base = { teamId: "co-android", userId: null, featureId: "offline-sync", repoId: null, baseCommit: null, headCommit: null, outcome: "shipped" as const };
  replaceDecisions({ ...base, executionId: "co-1", validFrom: 1_000 }, [
    { title: "Flush the queue on connectivity only", context: "", decision: "The worker runs when the network comes back.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
  ]);
  replaceDecisions({ ...base, executionId: "co-2", validFrom: 2_000 }, [
    { title: "Flush the queue on a timer as well", context: "", decision: "Every 30s and on connectivity.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
  ]);
  replaceDecisions({ ...base, executionId: "co-3", validFrom: 3_000 }, [
    { title: "Conflicts: last writer wins by server time", context: "", decision: "Server timestamp decides.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
  ]);
  upsertImplementation({ featureId: "offline-sync", teamId: "co-android", summary: "Old summary.", pitfalls: "" });
}

describe("the consolidation pass", () => {
  it("rewrites the page from every decision and closes what a later one replaced", async () => {
    seed();
    const scope = memoryScopeFor("co-android");
    const [first, second, third] = ["co-1", "co-2", "co-3"].map((e) => searchDecisions(scope, { limit: 50 }).find((d) => d.executionId === e)!);
    const provider = new FakeModelProvider((req) => {
      const prompt = String(req.messages[0].content);
      expect(prompt).toContain("Old summary.");
      expect(prompt).toContain(first.id);
      expect(prompt).toContain("Every decision, oldest first (3)");
      return JSON.stringify({
        summary: "Queue, flushed on a timer and on connectivity; server time settles conflicts.",
        pitfalls: "Ordering is per entity.",
        superseded: [
          { id: first.id, by: second.id, reason: "the timer flush replaced the connectivity-only rule" },
          { id: third.id, by: first.id, reason: "backwards: ignored" },
          { id: second.id, by: second.id, reason: "itself: ignored" },
          { id: "nope", by: second.id, reason: "unknown: ignored" },
        ],
        duplicateOf: null,
      });
    });
    const outcome = await consolidateImplementation(scope, "offline-sync", "co-android", provider, { model: "sonnet", now: () => 9_000 });
    expect(outcome).toMatchObject({ status: "done", decisionsRead: 3, superseded: 1 });
    expect(getImplementation("offline-sync", "co-android")).toMatchObject({ summary: "Queue, flushed on a timer and on connectivity; server time settles conflicts.", pitfalls: "Ordering is per entity." });
    expect(getDecision(first.id)!.validTo).toBe(2_000);
    expect(getDecision(second.id)!.supersedes).toBe(first.id);
    expect(getDecision(third.id)!.validTo).toBeNull();
    // What held on day 1500 and what holds now differ by exactly that closure.
    expect(searchDecisions(scope, { featureId: "offline-sync", asOf: 1_500 }).map((d) => d.executionId)).toEqual(["co-1"]);
    expect(searchDecisions(scope, { featureId: "offline-sync", asOf: 9_500 }).map((d) => d.executionId).sort()).toEqual(["co-2", "co-3"]);
    const [pass] = consolidationsOf("offline-sync");
    expect(pass).toMatchObject({ teamId: "co-android", status: "done", decisionsRead: 3, superseded: 1 });
    // Consolidated: not due again until enough new decisions land.
    expect(dueConsolidations(1)).toEqual([]);
    expect(dueConsolidations(0)).toEqual([]);
  });

  it("is due once enough new decisions land, and skips what the scope cannot see", async () => {
    seed();
    replaceDecisions({ teamId: "co-android", userId: null, featureId: "offline-sync", repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", executionId: "co-4", validFrom: 4_000 }, [
      { title: "Retry with backoff", context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", touches: [] },
    ]);
    upsertImplementation({ featureId: "offline-sync", teamId: "co-android", summary: "s", pitfalls: "" });
    expect(dueConsolidations(1)).toEqual([{ featureId: "offline-sync", teamId: "co-android" }]);
    expect(dueConsolidations(5)).toEqual([]);
    const provider = new FakeModelProvider(() => JSON.stringify({ summary: "x", pitfalls: "", superseded: [], duplicateOf: null }));
    expect(await consolidateImplementation(memoryScopeFor("co-other"), "offline-sync", "co-android", provider)).toMatchObject({ status: "skipped" });
    expect(provider.calls).toHaveLength(0);
  });

  it("records a bad answer as a failed pass and leaves the page alone", async () => {
    seed();
    const before = getImplementation("offline-sync", "co-android")!.summary;
    const provider = new FakeModelProvider(() => "I would rather not.");
    expect(await consolidateImplementation(memoryScopeFor("co-android"), "offline-sync", "co-android", provider)).toMatchObject({ status: "failed" });
    expect(getImplementation("offline-sync", "co-android")!.summary).toBe(before);
    expect(consolidationsOf("offline-sync")[0]).toMatchObject({ status: "failed" });
    expect(consolidationsOf("offline-sync")[0].error).toMatch(/shape/);
    expect(parseConsolidatorAnswer('```json\n{"summary":"s"}\n```')).toMatchObject({ summary: "s", superseded: [] });
  });
});

describe("what a consolidation pass may close, and how often it tries", () => {
  function team() {
    if (!getTeam("co2-org")) createTeam("Consolidate two", "co2-org");
  }

  it("never closes a decision of the team's other repository", async () => {
    team();
    const f = upsertFeature({ orgId: "co2-org", name: "Retries across repos" });
    const base = { teamId: "co2-org", userId: null, featureId: f.id, baseCommit: null, headCommit: null, outcome: "merged" as const };
    const [server] = replaceDecisions({ ...base, executionId: "co2-server", repoId: "github.com/x/server", validFrom: 100 }, [{ context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", title: "Server: retries 3", touches: [] }]);
    const [app] = replaceDecisions({ ...base, executionId: "co2-app", repoId: "github.com/x/app", validFrom: 200 }, [{ context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", title: "App: retries 5", touches: [] }]);
    upsertImplementation({ featureId: f.id, teamId: "co2-org", summary: "" });
    const provider = new FakeModelProvider(() => JSON.stringify({ summary: "s", pitfalls: "", superseded: [{ id: server.id, by: app.id, reason: "later" }], duplicateOf: null }));
    expect(await consolidateImplementation(memoryScopeFor("co2-org"), f.id, "co2-org", provider)).toMatchObject({ status: "done", superseded: 0 });
    expect(getDecision(server.id)!.validTo).toBeNull();
  });

  it("stops trying the same decisions after three failed passes, and tries again when a new one lands", async () => {
    team();
    const f = upsertFeature({ orgId: "co2-org", name: "Always failing page" });
    const base = { teamId: "co2-org", userId: null, featureId: f.id, repoId: null, baseCommit: null, headCommit: null, outcome: "merged" as const };
    replaceDecisions({ ...base, executionId: "co2-fail-1", validFrom: 1 }, [{ context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", title: "one", touches: [] }, { context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", title: "two", touches: [] }]);
    upsertImplementation({ featureId: f.id, teamId: "co2-org", summary: "" });
    const due = () => dueConsolidations(1, 100).some((x) => x.featureId === f.id);
    const provider = new FakeModelProvider(() => "not json");
    for (let i = 0; i < 3; i++) {
      expect(due()).toBe(true);
      expect(await consolidateImplementation(memoryScopeFor("co2-org"), f.id, "co2-org", provider)).toMatchObject({ status: "failed" });
    }
    expect(due()).toBe(false);
    // The failures are on the ledger, where a person reads them.
    expect(consolidationsOf(f.id).filter((c) => c.status === "failed")).toHaveLength(3);
    replaceDecisions({ ...base, executionId: "co2-fail-2", validFrom: 2 }, [{ context: "", decision: "", rationale: "", alternatives: "", how: "", consequences: "", title: "three", touches: [] }]);
    upsertImplementation({ featureId: f.id, teamId: "co2-org", summary: "" });
    expect(due()).toBe(true);
  });
});
