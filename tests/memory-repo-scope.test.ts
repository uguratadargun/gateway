import { describe, expect, it } from "vitest";

import { createTeam, teamAncestors } from "@/lib/teams";
import { insertIssue, liveIssues } from "@/memory/issues";
import { decisionsForExecution, getDecision, memoryScopeFor, replaceDecisions, searchDecisions } from "@/memory/store";

/**
 * One team, several repositories — which is the ordinary case here, not an
 * edge one: the mobile team owns an app and its SDK, and every repository in
 * the company has a `src/index.ts`.
 *
 * A relative path is only meaningful next to the repository it is relative to,
 * so the thing these tests hold down is that the path is never the whole key.
 * The failure they exist to catch is silent in every direction: a planner
 * reading the wrong repository's decision plans against a constraint that does
 * not apply to it, and nothing anywhere says so.
 */

/** The fields a recorder always fills, so each test names only what it is about. */
function draft(d: { title: string; decision: string; supersedes?: string; touches: { kind: "file" | "area"; ref: string }[] }) {
  return { context: "", rationale: "", alternatives: "", how: "", consequences: "", ...d };
}

const APP = "github.com/ulak/mobile-app";
const SDK = "github.com/ulak/mobile-sdk";

function seed() {
  if (!teamAncestors("rs-ulak").length) {
    createTeam("RS Ulak", "rs-ulak");
    createTeam("RS Mobile", "rs-mobile", "rs-ulak");
  }
  if (decisionsForExecution("rs-app-1").length) return;

  const touches = [{ kind: "file" as const, ref: "src/index.ts" }];
  const base = { teamId: "rs-mobile", userId: null, featureId: null, baseCommit: null, headCommit: null, outcome: "shipped" as const };
  replaceDecisions(
    { ...base, executionId: "rs-app-1", repoId: APP, validFrom: 1_000 },
    [draft({ title: "The app boots through a splash controller", decision: "src/index.ts hands off to SplashController", touches })],
    1_000,
  );
  replaceDecisions(
    { ...base, executionId: "rs-sdk-1", repoId: SDK, validFrom: 1_000 },
    [draft({ title: "The SDK exports one entry point", decision: "src/index.ts re-exports the public surface only", touches })],
    1_000,
  );
  // Recorded before identity existed: it belongs to neither and is hidden from
  // neither, because unknown is not evidence of difference.
  replaceDecisions(
    { ...base, executionId: "rs-old-1", repoId: null, validFrom: 1_000 },
    [draft({ title: "An older decision, from before repositories had names", decision: "kept", touches })],
    1_000,
  );
}

describe("the same path in two repositories", () => {
  const mobile = () => memoryScopeFor("rs-mobile");

  it("answers a path question with this repository's decision, plus the ones nobody named", () => {
    seed();
    const inApp = searchDecisions(mobile(), { paths: ["src/index.ts"], repoId: APP });
    expect(inApp.map((d) => d.executionId).sort()).toEqual(["rs-app-1", "rs-old-1"]);

    const inSdk = searchDecisions(mobile(), { paths: ["src/index.ts"], repoId: SDK });
    expect(inSdk.map((d) => d.executionId).sort()).toEqual(["rs-old-1", "rs-sdk-1"]);
  });

  it("filters the text search too, not only the path one", () => {
    seed();
    // The FTS branch reaches paths through a text column no join can filter,
    // so it has to be the decision's own repo that limits it.
    const hits = searchDecisions(mobile(), { query: "entry point export surface", repoId: APP });
    expect(hits.map((d) => d.executionId)).not.toContain("rs-sdk-1");
  });

  it("shows everything when the asker does not know which repository it is in", () => {
    seed();
    // No filter at all, deliberately: a caller that cannot name its own
    // repository is in no position to rule another one out, and a half-answer
    // that looks whole is worse than an answer with a stranger in it.
    const all = searchDecisions(mobile(), { paths: ["src/index.ts"] });
    expect(all.map((d) => d.executionId).sort()).toEqual(["rs-app-1", "rs-old-1", "rs-sdk-1"]);
  });

  it("will not let a run in one repository close a decision made in the other", () => {
    seed();
    const sdkDecision = decisionsForExecution("rs-sdk-1")[0];
    replaceDecisions(
      {
        teamId: "rs-mobile",
        userId: null,
        featureId: null,
        repoId: APP,
        baseCommit: null,
        headCommit: null,
        outcome: "shipped",
        validFrom: 2_000,
        executionId: "rs-app-2",
      },
      [draft({ title: "The app boots straight into the router", decision: "no splash", supersedes: sdkDecision.id, touches: [] })],
      2_000,
    );
    // Same team, so the team check passes; different repository, so it does
    // not. The SDK's decision still holds, and its team was never told
    // anything happened — which is exactly why this cannot be allowed.
    expect(getDecision(sdkDecision.id)!.validTo).toBeNull();
    expect(decisionsForExecution("rs-app-2")[0].supersedes).toBeNull();
  });

  it("raises a path objection against this repository and not its neighbour", () => {
    seed();
    for (const [n, repoId] of [["app", APP], ["sdk", SDK]] as const) {
      insertIssue({
        executionId: `rs-iss-${n}`,
        stepIndex: 0,
        sourceNodeId: "planner",
        sourceVisit: 1,
        conflictKey: `entry-${n}`,
        fromTeamId: "rs-mobile",
        targetTeamId: "rs-mobile",
        repoId,
        paths: ["src/index.ts"],
        title: `the entry point in the ${n} cannot stay as it is`,
      });
    }

    const found = liveIssues(mobile(), { paths: ["src/index.ts"], repoId: APP });
    expect(found.map((i) => i.conflictKey)).toEqual(["entry-app"]);
  });
});
