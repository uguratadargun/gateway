import { describe, expect, it } from "vitest";

import { nextInSession } from "@/client/walk";
import type { ExecutionStepRecord } from "@/executions/types";
import { parseWorkflow } from "@/workflows/loader";

/**
 * Where a session-driven run has got to, worked out from its steps alone.
 *
 * Each `gate next` is a new process, so this replay is the whole of the run's
 * memory. What it must get right: the same edges the engine would take, and a
 * parallel node's branches walked one at a time — the only place a session
 * deliberately differs from the engine.
 */

const AGENTS = new Set(["planner", "reviewer", "guard"]);

const WORKFLOW = parseWorkflow(
  "dev",
  `name: Dev
entry: setup
nodes:
  - id: setup
    type: command
    command: ["true"]
    next: planner

  - id: planner
    type: agent
    agent: planner
    edges:
      - when: outputs.planner.ok == true
        to: checks
      - to: give-up

  - id: checks
    type: parallel
    branches: [reviewer, guard]
    join: verdict

  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict

  - id: guard
    type: agent
    agent: guard
    next: verdict

  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: done
      - to: planner

  - id: done
    type: terminal

  - id: give-up
    type: terminal
    status: failed
`,
  { sourcePath: "/tmp/dev.yaml", updatedAt: 0, agentExists: (id) => AGENTS.has(id) },
);

let index = 0;
function step(nodeId: string, output: unknown, status: "completed" | "failed" = "completed"): ExecutionStepRecord {
  return {
    executionId: "e",
    stepIndex: index++,
    nodeId,
    visit: 1,
    status,
    startedAt: 0,
    finishedAt: 1,
    input: null,
    output,
    error: status === "failed" ? { code: "COMMAND_FAILED", message: "no" } : null,
    usage: null,
    toolCalls: null,
  };
}

function reset() {
  index = 0;
}

describe("finding the next node from history", () => {
  it("starts at the entry node", () => {
    reset();
    const at = nextInSession(WORKFLOW, [], {});
    expect(at).toMatchObject({ kind: "node", stepIndex: 0 });
    expect(at.kind === "node" && at.node.id).toBe("setup");
  });

  it("follows the edge the outputs choose", () => {
    reset();
    const at = nextInSession(WORKFLOW, [step("setup", { ok: true })], {});
    expect(at.kind === "node" && at.node.id).toBe("planner");
    // And the node about to run sees what came before it.
    expect(at.kind === "node" && at.outputs).toEqual({ setup: { ok: true } });
  });

  it("walks a parallel node's branches one at a time", () => {
    reset();
    const history = [step("setup", null), step("planner", { ok: true }), step("checks", null)];
    let at = nextInSession(WORKFLOW, history, {});
    expect(at.kind === "node" && at.node.id).toBe("reviewer");

    history.push(step("reviewer", { verdict: "approved" }));
    at = nextInSession(WORKFLOW, history, {});
    // The second branch, not the join: a session does one thing at a time.
    expect(at.kind === "node" && at.node.id).toBe("guard");

    history.push(step("guard", { findings: [] }));
    at = nextInSession(WORKFLOW, history, {});
    expect(at.kind === "node" && at.node.id).toBe("verdict");
  });

  it("reaches the terminal the conditions lead to", () => {
    reset();
    const history = [
      step("setup", null),
      step("planner", { ok: true }),
      step("checks", null),
      step("reviewer", { verdict: "approved" }),
      step("guard", { findings: [] }),
      step("verdict", null),
    ];
    expect(nextInSession(WORKFLOW, history, {})).toMatchObject({ kind: "done", status: "completed", terminalNodeId: "done" });
  });

  it("goes round the loop when the verdict sends it back", () => {
    reset();
    const history = [
      step("setup", null),
      step("planner", { ok: true }),
      step("checks", null),
      step("reviewer", { verdict: "rejected" }),
      step("guard", { findings: [] }),
      step("verdict", null),
    ];
    const at = nextInSession(WORKFLOW, history, {});
    expect(at.kind === "node" && at.node.id).toBe("planner");
    // Second time round, which is what a loop ceiling counts.
    expect(at.kind === "node" && at.visit).toBe(2);
  });

  it("takes a terminal that fails as a failed run", () => {
    reset();
    const history = [step("setup", null), step("planner", { ok: false })];
    expect(nextInSession(WORKFLOW, history, {})).toMatchObject({ kind: "done", status: "failed", terminalNodeId: "give-up" });
  });

  it("walks past a node that is switched off", () => {
    reset();
    const off = parseWorkflow(
      "dev",
      `name: Dev
entry: setup
nodes:
  - id: setup
    type: command
    command: ["true"]
    disabled: true
    next: planner
  - id: planner
    type: agent
    agent: planner
    next: done
  - id: done
    type: terminal
`,
      { sourcePath: "/tmp/dev.yaml", updatedAt: 0, agentExists: (id) => AGENTS.has(id) },
    );
    const at = nextInSession(off, [], {});
    // Not handed to the session, and no step of its own: the first thing the
    // run is asked to do is the node after it.
    expect(at.kind === "node" && at.node.id).toBe("planner");
    expect(at.kind === "node" && at.stepIndex).toBe(0);
  });

  it("replays a step a node produced before it was switched off", () => {
    reset();
    const off = parseWorkflow(
      "dev",
      `name: Dev
entry: setup
nodes:
  - id: setup
    type: command
    command: ["true"]
    disabled: true
    next: planner
  - id: planner
    type: agent
    agent: planner
    next: done
  - id: done
    type: terminal
`,
      { sourcePath: "/tmp/dev.yaml", updatedAt: 0, agentExists: (id) => AGENTS.has(id) },
    );
    // The run did `setup` and was then edited mid-flight. History is what
    // happened, so the step is consumed rather than stepped over — otherwise
    // every later step would line up against the wrong node.
    const at = nextInSession(off, [step("setup", { ok: true })], {});
    expect(at.kind === "node" && at.node.id).toBe("planner");
    expect(at.kind === "node" && at.stepIndex).toBe(1);
    expect(at.kind === "node" && at.outputs).toEqual({ setup: { ok: true } });
  });

  it("stops at a step that failed rather than walking past it", () => {
    reset();
    const at = nextInSession(WORKFLOW, [step("setup", null, "failed")], {});
    expect(at).toMatchObject({ kind: "failed", nodeId: "setup" });
  });
});
