import { describe, expect, it } from "vitest";

import { recordReportedSteps, reconcilePendingApprovals } from "@/executions/record";
import { createExecution, getExecution } from "@/executions/store";
import { getDb } from "@/lib/db";
import { createTeam, teamAncestors } from "@/lib/teams";
import {
  approvalsForExecution,
  findIssue,
  getIssue,
  issuesForExecution,
  liveIssues,
  pendingApprovals,
  resolveIssue,
} from "@/memory/issues";
import { LocalMemoryAccess } from "@/memory/access";
import { describeSearch } from "@/memory/cards";
import { memoryOfExecution, memoryScopeFor, replaceDecisions } from "@/memory/store";
import type { ExecutionRecord } from "@/executions/types";
import type { StepRecord } from "@/runtime/state";

/**
 * An objection one team raises against another's decision, and the answer a
 * person gives to it — written with the step that carried them, or not at all.
 *
 * The case underneath every test here is the real one: desktop decided
 * something, the server team's planner read that decision out of memory,
 * judged it incompatible and asked the person, and the person agreed. What
 * used to happen next was nothing. What has to happen is that desktop's next
 * planner reads the objection.
 */

function tree() {
  if (!teamAncestors("ulak").length) {
    createTeam("Ulak", "ulak");
    createTeam("Android", "android", "ulak");
    createTeam("Desktop", "desktop", "ulak");
    createTeam("Other Co", "otherco");
  }
  if (!teamAncestors("srv").length) createTeam("Server", "srv", "ulak");
}

let n = 0;
function run(teamId: string): ExecutionRecord {
  tree();
  const id = `xt-${teamId}-${++n}`;
  createExecution(id, "dev", {}, 1000, null, { teamId });
  return getExecution(id)!;
}

function step(over: Partial<StepRecord> & { stepIndex: number; nodeId: string }): StepRecord {
  return {
    visit: 0,
    status: "completed",
    startedAt: 1000,
    finishedAt: 2000,
    input: {},
    output: {},
    ...over,
  } as StepRecord;
}

const conflict = (over: Record<string, unknown> = {}) => ({
  conflictKey: "pq-kem",
  targetTeamId: "desktop",
  title: "desktop's KEM choice does not fit the server handshake",
  decisionSnapshot: "desktop settled on X25519+Kyber768 hybrid in the client",
  rationale: "our handshake cannot carry the second key share in the first flight",
  proposal: "move the share to the second flight",
  revision: "revise the client handshake before shipping",
  paths: ["src/crypto"],
  ...over,
});

describe("an objection is written with its step", () => {
  it("records the step once and raises the objection once, however often the batch is re-sent", () => {
    const ex = run("srv");
    const s = step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } });

    const first = recordReportedSteps(ex, [s]);
    expect(first.recorded).toBe(1);
    expect(first.issuesRaised).toBe(1);

    // The client's report failed on the way back; it sends the same batch again.
    const second = recordReportedSteps(ex, [s]);
    expect(second.recorded).toBe(0);
    expect(second.issuesRaised).toBe(0);

    expect(issuesForExecution(ex.id)).toHaveLength(1);
    const rows = getDb().prepare("SELECT COUNT(*) c FROM workflow_execution_steps WHERE execution_id = ?").get(ex.id);
    expect(Number(rows!.c)).toBe(1);
  });

  it("writes nothing at all when the write throws part of the way through", () => {
    const ex = run("srv");
    const good = step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } });
    // `startedAt` is NOT NULL: a step the client could never have sent, but a
    // faithful stand-in for the database refusing halfway down the batch.
    const bad = { ...step({ stepIndex: 1, nodeId: "impl" }), startedAt: undefined } as unknown as StepRecord;

    expect(() => recordReportedSteps(ex, [good, bad])).toThrow();
    expect(issuesForExecution(ex.id)).toHaveLength(0);
    const rows = getDb().prepare("SELECT COUNT(*) c FROM workflow_execution_steps WHERE execution_id = ?").get(ex.id);
    expect(Number(rows!.c)).toBe(0);
  });

  it("refuses an objection that claims a node and visit another step already claimed", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } })]);
    // Same node, same visit, same key — but reported under a different step.
    // There is no way to tell which one is the objection, so neither is.
    const out = recordReportedSteps(ex, [step({ stepIndex: 1, nodeId: "planner", output: { conflicts: [conflict({ title: "different words" })] } })]);
    expect(out.recorded).toBe(1);
    expect(out.issuesRaised).toBe(0);
    expect(out.skipped[0].reason).toMatch(/another step/);
    expect(issuesForExecution(ex.id)).toHaveLength(1);
  });

  it("keeps a step whose objection field is nonsense, and says why it changed nothing", () => {
    const ex = run("srv");
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: "none", plan: "…" } })]);
    // The model was talking, not sending a protocol message. The run goes on.
    expect(out.recorded).toBe(1);
    expect(out.issuesRaised).toBe(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].field).toBe("conflicts");
    expect(issuesForExecution(ex.id)).toHaveLength(0);
  });

  it("will not let a run object to a team outside its own family", () => {
    const ex = run("srv");
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ targetTeamId: "otherco" })] } })]);
    expect(out.issuesRaised).toBe(0);
    expect(out.skipped[0].reason).toMatch(/not in this run's family/);
  });

  it("tells a repeated planner visit apart from a re-sent report", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", visit: 0, output: { conflicts: [conflict()] } })]);
    // The graph came back round to the planner. Same node, same key, new visit:
    // a new objection, because the planner is saying it again about new work.
    const out = recordReportedSteps(ex, [step({ stepIndex: 4, nodeId: "planner", visit: 1, output: { conflicts: [conflict()] } })]);
    expect(out.issuesRaised).toBe(1);
    expect(issuesForExecution(ex.id)).toHaveLength(2);
  });
});

describe("a person's answer", () => {
  it("is kept when it arrives before the objection, and settles when the objection lands", () => {
    const ex = run("srv");
    const answer = step({
      stepIndex: 3,
      nodeId: "ask",
      output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "pq-kem", decision: "confirm", note: "yes, they are right" }] },
    });

    // The batch carrying the planner's step was refused on the way here; the
    // approval's own batch got through first. The answer is not lost.
    const first = recordReportedSteps(ex, [answer]);
    expect(first.recorded).toBe(1);
    expect(first.approvalsKept).toBe(1);
    expect(first.approvalsPending).toBe(1);
    expect(approvalsForExecution(ex.id)[0].status).toBe("pending_source");
    expect(issuesForExecution(ex.id)).toHaveLength(0);

    // Other steps in that batch were still recorded — nothing was held back.
    const other = recordReportedSteps(ex, [step({ stepIndex: 4, nodeId: "impl" })]);
    expect(other.recorded).toBe(1);

    const late = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } })]);
    expect(late.issuesRaised).toBe(1);

    const issue = findIssue(ex.id, "planner", 0, "pq-kem")!;
    expect(issue.status).toBe("open");
    const settled = approvalsForExecution(ex.id).find((a) => a.nodeId === "ask")!;
    expect(settled.status).toBe("applied");
    expect(settled.issueId).toBe(issue.id);
  });

  it("makes one row and one transition however many times its batch is re-sent", () => {
    const ex = run("srv");
    const answer = step({
      stepIndex: 3,
      nodeId: "ask",
      output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "pq-kem", decision: "confirm", note: "" }] },
    });
    recordReportedSteps(ex, [answer]);
    recordReportedSteps(ex, [answer]);
    recordReportedSteps(ex, [answer]);
    expect(approvalsForExecution(ex.id)).toHaveLength(1);

    recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } })]);
    // A sweep after a restart finds nothing left to do, and does nothing.
    const sweep = reconcilePendingApprovals();
    expect(sweep.settled).toBe(0);

    expect(findIssue(ex.id, "planner", 0, "pq-kem")!.status).toBe("open");
    expect(approvalsForExecution(ex.id)).toHaveLength(1);
  });

  it("stays visibly waiting when its objection never arrives", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({
        stepIndex: 3,
        nodeId: "ask",
        output: { resolved: [{ sourceNodeId: "gone", sourceVisit: 0, conflictKey: "never-sent", decision: "confirm", note: "" }] },
      }),
    ]);
    // A restart is not a reason to forget what a person said. It is still
    // there, still marked as waiting, and still findable.
    reconcilePendingApprovals();
    const held = pendingApprovals().find((a) => a.conflictKey === "never-sent");
    expect(held).toBeTruthy();
    expect(held!.status).toBe("pending_source");
  });

  it("cannot reopen an objection the other team already closed", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "closed-one" })] } })]);
    const issue = findIssue(ex.id, "planner", 0, "closed-one")!;
    resolveIssue(issue.id, "desktop", "revised on our side", 5000);

    // The approval was in a batch that took four tries to land. By the time it
    // did, desktop had already dealt with the objection.
    const out = recordReportedSteps(ex, [
      step({
        stepIndex: 9,
        nodeId: "ask",
        output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "closed-one", decision: "confirm", note: "" }] },
      }),
    ]);
    expect(out.approvalsKept).toBe(1);
    expect(getIssue(issue.id)!.status).toBe("resolved");
    expect(getIssue(issue.id)!.resolvedBy).toBe("desktop");
    const late = approvalsForExecution(ex.id).find((a) => a.conflictKey === "closed-one")!;
    expect(late.status).toBe("applied");
    expect(late.reason).toMatch(/already resolved/);
  });

  it("marks two people who answered the same objection differently, rather than letting the last one win", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "two-minds" })] } })]);
    recordReportedSteps(ex, [
      step({
        stepIndex: 1,
        nodeId: "ask",
        output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "two-minds", decision: "confirm", note: "they are right" }] },
      }),
      step({
        stepIndex: 2,
        nodeId: "ask-again",
        output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "two-minds", decision: "reject", note: "no, ours is fine" }] },
      }),
    ]);
    const issue = findIssue(ex.id, "planner", 0, "two-minds")!;
    expect(issue.status).toBe("open");
    const second = approvalsForExecution(ex.id).find((a) => a.nodeId === "ask-again")!;
    expect(second.status).toBe("rejected");
    expect(second.conflicted).toBe(true);
  });
});

describe("what the other team reads", () => {
  it("shows an objection to the team it was raised against, by the paths it touches", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "recall-me", paths: ["src/crypto/handshake.ts"] })] } }),
    ]);
    // Desktop never ran anything. It learns of the disagreement because its
    // own recall asks about the file it is on.
    const found = liveIssues(memoryScopeFor("desktop"), { paths: ["src/crypto/handshake.ts"] });
    expect(found.map((i) => i.conflictKey)).toContain("recall-me");
    expect(found.find((i) => i.conflictKey === "recall-me")!.targetTeamId).toBe("desktop");
  });

  it("keeps an objection inside the family it belongs to", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "family-only", paths: ["src/crypto/kem.ts"] })] } }),
    ]);
    expect(liveIssues(memoryScopeFor("otherco"), { paths: ["src/crypto/kem.ts"] }).map((i) => i.conflictKey)).not.toContain("family-only");
  });

  it("puts it in front of the other team's planner, in the words of a request", async () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "the-real-case", paths: ["src/pq/handshake.ts"] })] } }),
    ]);
    recordReportedSteps(ex, [
      step({
        stepIndex: 1,
        nodeId: "ask",
        output: { resolved: [{ sourceNodeId: "planner", sourceVisit: 0, conflictKey: "the-real-case", decision: "confirm", note: "yes" }] },
      }),
    ]);

    // This is the whole point of the feature: desktop asks memory about the
    // file it is about to work on, and learns that the server team read its
    // decision, could not live with it, and a person agreed with them.
    const result = await new LocalMemoryAccess("desktop").search({ paths: ["src/pq/handshake.ts"] });
    const found = result.issues.find((i) => i.title.includes("KEM choice"));
    expect(found).toBeTruthy();
    expect(found!.status).toBe("open");
    expect(found!.target).toBe("desktop");

    const text = describeSearch(result);
    expect(text).toContain("against this team's own decisions");
    expect(text).toContain("confirmed by a person");
    expect(text).toContain("revision request");
  });

  it("warns instead of reading silence as agreement when an answer lost its objection", async () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({
        stepIndex: 7,
        nodeId: "ask",
        output: { resolved: [{ sourceNodeId: "lost", sourceVisit: 0, conflictKey: "lost-objection", decision: "confirm", note: "" }] },
      }),
    ]);
    const result = await new LocalMemoryAccess("srv").search({ paths: ["src/anything"] });
    expect(result.heldAnswers).toBeGreaterThan(0);
    expect(describeSearch(result)).toContain("not proof nobody objected");
  });

  it("survives the recorder running over the same run again", async () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "outlives-recorder", paths: ["src/pq/rekey.ts"] })] } }),
    ]);

    // The recorder replaces a run's decisions whole, and gives them new ids
    // each time. That is exactly why an objection is not one of them: a
    // re-record after a recorder fix would otherwise quietly drop it.
    replaceDecisions(
      { executionId: ex.id, teamId: "srv", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "completed", validFrom: 7000 },
      [{ title: "the run's own decision", context: "", decision: "d", rationale: "", how: "", consequences: "", alternatives: "", touches: [{ kind: "file", ref: "src/pq/rekey.ts" }] }],
      7000,
    );
    replaceDecisions(
      { executionId: ex.id, teamId: "srv", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "completed", validFrom: 8000 },
      [{ title: "recorded again, new ids", context: "", decision: "d", rationale: "", how: "", consequences: "", alternatives: "", touches: [{ kind: "file", ref: "src/pq/rekey.ts" }] }],
      8000,
    );

    expect(findIssue(ex.id, "planner", 0, "outlives-recorder")!.status).toBe("proposed");
    const result = await new LocalMemoryAccess("desktop").search({ paths: ["src/pq/rekey.ts"] });
    expect(result.issues.map((i) => i.id)).toContain(findIssue(ex.id, "planner", 0, "outlives-recorder")!.id);
    // The run's memory screen shows it next to what the recorder made.
    expect(memoryOfExecution(ex.id).issues.map((i) => i.conflictKey)).toContain("outlives-recorder");
  });

  it("stops showing one once it is dealt with", () => {
    const ex = run("srv");
    recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict({ conflictKey: "done-with", paths: ["src/done"] })] } }),
    ]);
    const issue = findIssue(ex.id, "planner", 0, "done-with")!;
    resolveIssue(issue.id, "desktop", "revised");
    expect(liveIssues(memoryScopeFor("desktop"), { paths: ["src/done"] }).map((i) => i.conflictKey)).not.toContain("done-with");
  });
});
