import { describe, expect, it } from "vitest";

import { createTeam, getTeam } from "@/lib/teams";
import { LocalMemoryAccess, describeSearch } from "@/memory/access";
import { describeFeature } from "@/memory/cards";
import { replaceDecisions, upsertFeature, upsertImplementation } from "@/memory/store";
import { parseSince } from "@/memory/since";

/**
 * What the recall node reads: the memory tools as `gate memory search` and
 * `gate memory feature` print them, in a scope that is the run's team and
 * nothing the model says.
 */

function seed() {
  if (getTeam("rc-ulak")) return;
  createTeam("Ulak", "rc-ulak");
  createTeam("Android", "rc-android", "rc-ulak");
  createTeam("Desktop", "rc-desktop", "rc-ulak");
  createTeam("Elsewhere", "rc-other");
  const f = upsertFeature({ orgId: "rc-ulak", name: "Offline sync", aliases: ["background sync"], summary: "Local queue, flushed when online." });
  replaceDecisions(
    { executionId: "rc-run-1", teamId: "rc-android", userId: null, featureId: f.id, repoId: null, baseCommit: "a1", headCommit: "b2", outcome: "shipped", validFrom: Date.now() - 86_400_000 },
    [
      {
        title: "Queue edits in a local table",
        context: "",
        decision: "Every edit is queued locally and flushed by a worker.",
        rationale: "Survives process death.",
        alternatives: "",
        how: "edit → queue row → worker → ack → delete.",
        consequences: "Per-entity ordering only.",
        touches: [{ kind: "file", ref: "app/sync/Queue.kt" }, { kind: "area", ref: "sync" }],
      },
    ],
  );
  upsertImplementation({ featureId: f.id, teamId: "rc-android", summary: "Room queue + WorkManager.", pitfalls: "Ordering is per entity." });
  replaceDecisions(
    { executionId: "rc-run-2", teamId: "rc-other", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
    [{ title: "Offline sync with CRDTs", context: "", decision: "CRDT merge.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
  );
}

describe("the recall node", () => {
  it("searches memory as the run's team, across its tree and nowhere else", async () => {
    seed();
    const access = new LocalMemoryAccess("rc-desktop");
    // The sibling team's decision and the catalogue entry, with ids; the
    // other tree's decision about the same words is not in the answer.
    const found = describeSearch(await access.search({ query: "offline sync for desktop edits" }));
    expect(found).toContain("offline-sync — Offline sync (also: background sync) · built by: rc-android");
    expect(found).toContain("Queue edits in a local table");
    expect(found).toContain("team: rc-android");
    expect(found).not.toContain("CRDT");

    const feature = describeFeature((await access.feature("offline-sync"))!);
    expect(feature).toContain("Room queue + WorkManager.");
    expect(feature).toContain("pitfalls: Ordering is per entity.");

    const byPath = describeSearch(await access.search({ paths: ["app/sync"], since: Date.now() - 30 * 86_400_000 }));
    expect(byPath).toContain("app/sync/Queue.kt");
    expect(byPath).toContain("commits a1..b2");
  });

  it("says plainly when nothing matches, and reads times the way people write them", async () => {
    seed();
    const empty = await new LocalMemoryAccess("rc-desktop").search({ query: "payment gateway chargeback" });
    expect(describeSearch(empty)).toMatch(/Nothing in memory matches/);
    const now = Date.UTC(2026, 8, 10);
    expect(parseSince("30d", now)).toBe(now - 30 * 86_400_000);
    expect(parseSince("6 months", now)).toBe(now - 180 * 86_400_000);
    expect(parseSince("2026-05-01", now)).toBe(Date.UTC(2026, 4, 1));
    expect(parseSince("soon", now)).toBeNull();
  });

  it("keeps another tree's catalogue closed", async () => {
    seed();
    expect(await new LocalMemoryAccess("rc-other").feature("offline-sync")).toBeNull();
    expect((await new LocalMemoryAccess("rc-android").feature("offline-sync"))?.implementations.map((i) => i.team)).toEqual(["rc-android"]);
  });
});
