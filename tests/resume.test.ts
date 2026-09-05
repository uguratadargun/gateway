import { describe, expect, it } from "vitest";

import { assertResumable, planResume } from "@/executions/resume";
import type { ExecutionStepRecord } from "@/executions/types";
import { parseWorkflow } from "@/workflows/loader";

/**
 * Where a stopped run picks back up. Pure logic, no engine or database
 * involved: given a workflow and the steps that already ran, what node does
 * it resume at, and does the reconstructed progress hold the same ceilings a
 * live run would.
 */

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };

const WORKFLOW = `
name: dev
entry: planner
maxVisits: 3
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation
  - id: implementation
    type: agent
    agent: implementation
    next: tests
  - id: tests
    type: command
    command: ["true"]
    edges:
      - when: outputs.tests.ok == true
        to: checks
        label: pass
      - to: implementation
        label: fail
  - id: checks
    type: parallel
    branches: [reviewer, security]
    join: verdict
  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict
  - id: security
    type: agent
    agent: security
    next: verdict
  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
        label: approved
      - to: implementation
        label: changes requested
  - id: done
    type: terminal
`;
const workflow = parseWorkflow("dev", WORKFLOW, meta);

let stepIndex = 0;
function step(nodeId: string, status: "completed" | "failed", output: unknown = null): ExecutionStepRecord {
  return {
    executionId: "e",
    stepIndex: stepIndex++,
    nodeId,
    visit: 1,
    status,
    startedAt: 0,
    finishedAt: 0,
    input: null,
    output,
    error: status === "failed" ? { code: "MODEL_EXECUTION_ERROR", message: "x" } : null,
    usage: null,
    toolCalls: null,
  };
}

describe("planResume", () => {
  it("retries the node a failed step happened in", () => {
    const plan = planResume(workflow, [step("planner", "completed", { plan: "x" }), step("implementation", "failed")], {});
    expect(plan.startNodeId).toBe("implementation");
    expect(plan.stepCount).toBe(2);
    expect(plan.visitCounts).toEqual({ planner: 1, implementation: 1 });
  });

  it("re-derives what runs next after a step that finished cleanly", () => {
    // The run stopped between "tests" completing and "checks" starting — the
    // same routing the engine used originally has to give the same answer.
    const plan = planResume(
      workflow,
      [
        step("planner", "completed", { plan: "x" }),
        step("implementation", "completed", { diff: "y" }),
        step("tests", "completed", { ok: true, exitCode: 0, stdout: "", stderr: "" }),
      ],
      {},
    );
    expect(plan.startNodeId).toBe("checks");
  });

  it("routes to a condition node's fallback edge exactly as the engine would", () => {
    const plan = planResume(
      workflow,
      [
        step("planner", "completed", { plan: "x" }),
        step("implementation", "completed", { diff: "y" }),
        step("tests", "completed", { ok: true, exitCode: 0, stdout: "", stderr: "" }),
        step("checks", "completed", { branches: ["reviewer", "security"], join: "verdict" }),
        step("reviewer", "completed", { verdict: "changes_requested" }),
        step("security", "completed", { verdict: "approved" }),
        step("verdict", "completed", null),
      ],
      {},
    );
    expect(plan.startNodeId).toBe("implementation");
  });

  it("sends a completed parallel node straight to its join, never through selectEdge", () => {
    const plan = planResume(
      workflow,
      [
        step("planner", "completed", { plan: "x" }),
        step("implementation", "completed", { diff: "y" }),
        step("tests", "completed", { ok: true, exitCode: 0, stdout: "", stderr: "" }),
        step("checks", "completed", { branches: ["reviewer", "security"], join: "verdict" }),
      ],
      {},
    );
    expect(plan.startNodeId).toBe("verdict");
  });

  it("keeps the cumulative visit count, so a node already at the ceiling stays there", () => {
    // Five attempts at "implementation" (maxVisits: 3 here is lower, so this
    // stands in for what a real LOOP_LIMIT_EXCEEDED run's history looks like:
    // no failed step for the attempt that tripped the ceiling, just the last
    // successful one, routed back to the same node again.
    const plan = planResume(
      workflow,
      [
        step("planner", "completed", { plan: "x" }),
        step("implementation", "completed", { diff: "1" }),
        step("tests", "completed", { ok: false, exitCode: 1, stdout: "", stderr: "" }),
        step("implementation", "completed", { diff: "2" }),
        step("tests", "completed", { ok: false, exitCode: 1, stdout: "", stderr: "" }),
        step("implementation", "completed", { diff: "3" }),
      ],
      {},
    );
    expect(plan.startNodeId).toBe("tests");
    expect(plan.visitCounts.implementation).toBe(3);
  });

  it("refuses when nothing ran yet", () => {
    expect(() => planResume(workflow, [], {})).toThrow(/nothing ran/);
  });

  // Reaching a terminal never gets a step of its own — the engine returns as
  // soon as it sees one — so a real history never actually ends on one. This
  // input is synthetic; it only proves the defensive branch does not crash.
  it("would refuse a terminal as a resume point, if one ever showed up in history", () => {
    const plan = () => planResume(workflow, [step("planner", "completed", { plan: "x" }), step("done", "completed", null)], {});
    expect(plan).toThrow(/already finished/);
  });

  it("refuses when the node it would resume at was removed from the workflow since", () => {
    const plan = () => planResume(workflow, [step("planner", "completed", { plan: "x" }), step("ghost", "failed")], {});
    expect(plan).toThrow(/no longer exists/);
  });

  it("carries the run's own input into the routing it re-derives", () => {
    const withInput = `
name: dev
entry: check
nodes:
  - id: check
    type: condition
    edges:
      - when: input.mode == "strict"
        to: strict
        label: strict
      - to: lenient
        label: lenient
  - id: strict
    type: terminal
  - id: lenient
    type: terminal
`;
    const wf = parseWorkflow("dev", withInput, meta);
    const plan = planResume(wf, [step("check", "completed", null)], { mode: "strict" });
    expect(plan.startNodeId).toBe("strict");
  });
});


describe("assertResumable", () => {
  it("refuses a run that is still going", () => {
    expect(() => assertResumable({ status: "running", error: null })).toThrow(/still going/);
    expect(() => assertResumable({ status: "running", error: { code: "X", message: "y" } })).toThrow(/still going/);
  });

  it("refuses a run that finished by reaching a terminal — no error means it ended on purpose", () => {
    expect(() => assertResumable({ status: "completed", error: null })).toThrow(/already finished/);
    // A terminal can itself declare status: failed; still nothing to continue.
    expect(() => assertResumable({ status: "failed", error: null })).toThrow(/already finished/);
  });

  it("allows a run that stopped somewhere still in progress", () => {
    expect(() => assertResumable({ status: "failed", error: { code: "RUN_CANCELLED", message: "run cancelled" } })).not.toThrow();
    expect(() => assertResumable({ status: "failed", error: { code: "LOOP_LIMIT_EXCEEDED", message: "x" } })).not.toThrow();
  });
});
