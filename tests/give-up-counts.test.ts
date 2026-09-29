import { describe, expect, it } from "vitest";

import { nextInSession } from "@/client/walk";
import type { ExecutionStepRecord } from "@/executions/types";
import { DEFAULT_WORKFLOWS } from "@/workflows/defaults";
import { parseWorkflow } from "@/workflows/loader";
import type { WorkflowDefinition } from "@/workflows/types";

/**
 * A give-up edge counts failures, not visits.
 *
 * Each loop in the shipped pipelines ends on a terminal that says what is
 * stuck — not-verified, no-spec, review-stuck — after a number of failed
 * rounds. Counted in visits of the node that judges, a verification that
 * passed, a record check that passed, or a review the reviewer approved and
 * the person sent back all spent one of those rounds, and a run could end on
 * the first failure of its third lap. These walk the real graphs, a lap at a
 * time, the way a session replays them.
 */

const parse = (id: string) => parseWorkflow(id, DEFAULT_WORKFLOWS[id], { sourcePath: `${id}.yaml`, updatedAt: 0 });
const cmd = (ok: boolean, stdout = "") => ({ exitCode: ok ? 0 : 1, ok, stdout, stderr: "" });

type Script = Array<[string, unknown]>;

/** Walks `script` node by node, failing loudly if the graph goes elsewhere, and says where it ends up. */
function walk(workflow: WorkflowDefinition, script: Script): string {
  const steps: ExecutionStepRecord[] = [];
  const at = () => nextInSession(workflow, steps, { task: "t" });
  for (const [nodeId, output] of script) {
    const pos = at();
    if (pos.kind !== "node" || pos.node.id !== nodeId) {
      throw new Error(`expected ${nodeId}, the walk is at ${pos.kind === "node" ? pos.node.id : JSON.stringify(pos)}`);
    }
    steps.push({ nodeId, status: "completed", output, visit: pos.visit, stepIndex: steps.length } as ExecutionStepRecord);
  }
  const end = at();
  return end.kind === "done" ? `terminal ${end.terminalNodeId}` : end.kind === "node" ? `node ${end.node.id}` : end.kind;
}

const planned: Script = [
  ["base", cmd(true, "abc")],
  ["plan-dir", cmd(true)],
  ["recall", { brief: "", sources: [], objections: [] }],
  ["planner", { questions: "", plan: "p", planFile: "f", notes: "", conflictKey: "" }],
  ["conflict-check", null],
  ["plan-check", null],
  ["plan-review", { decision: "approve" }],
  ["plan-decision", null],
];

const built = (verified = true): Script => [
  ["implementer", { summary: "s", changed: true }],
  ["verifier", { verified, evidence: "e" }],
];
const gap: Script = [...built(false), ["gaps", null]];
const reviewed = (verdict: "approved" | "rejected"): Script => [
  ["record", cmd(true)],
  ["stage", cmd(true)],
  ["diff", cmd(true, " a | 1 +")],
  ["reviewer", { verdict, replan: false, recordOnly: false }],
  ["verdict", null],
  ...(verdict === "rejected" ? ([["rejected", null]] as Script) : []),
];
const rejectedLap: Script = [...built(), ...reviewed("rejected")];

describe("dev's give-up edges", () => {
  const dev = parse("dev");

  it("do not count a verification that passed on an earlier lap", () => {
    // Two laps verified green first time and rejected in review, then one gap.
    expect(walk(dev, [...planned, ...rejectedLap, ...rejectedLap, ...gap])).toBe("node implementer");
    // Three failed checks still end the run.
    expect(walk(dev, [...planned, ...gap, ...gap, ...built(false)])).toBe("node gaps");
    expect(walk(dev, [...planned, ...gap, ...gap, ...gap])).toBe("terminal not-verified");
  });

  it("do not count a record check that passed on an earlier lap", () => {
    const missing: Script = [...built(), ["record", cmd(false, "Decision numbers already taken")], ["record-missing", null]];
    expect(walk(dev, [...planned, ...rejectedLap, ...rejectedLap, ...missing])).toBe("node implementer");
    expect(walk(dev, [...planned, ...missing, ...missing, ...missing])).toBe("terminal no-spec");
  });

  it("do not count a review that was approved and sent back by the person", () => {
    const approvedThenRevised: Script = [
      ...built(),
      ...reviewed("approved"),
      ["stage-all", cmd(true)],
      ["staged", cmd(true)],
      ["acceptance", { decision: "revise", replan: false, requests: "r" }],
      ["decision", null],
    ];
    const threeRevisions = [...approvedThenRevised, ...approvedThenRevised, ...approvedThenRevised];
    // The fourth review, and the first rejection of the run.
    expect(walk(dev, [...planned, ...threeRevisions, ...rejectedLap])).toBe("node implementer");
    // Four rejections are still four.
    expect(walk(dev, [...planned, ...rejectedLap, ...rejectedLap, ...rejectedLap, ...rejectedLap])).toBe("terminal review-stuck");
  });
});

describe("dev-quick's give-up edge", () => {
  const quick = parse("dev-quick");
  const start: Script = [
    ["base", cmd(true, "abc")],
    ["recall", { brief: "", sources: [], objections: [] }],
  ];
  const lap = (verdict: "approved" | "rejected"): Script => [
    ["implementer", { summary: "s", changed: true }],
    ["record", cmd(true)],
    ["stage", cmd(true)],
    ["diff", cmd(true, " a | 1 +")],
    ["reviewer", { verdict }],
    ["verdict", null],
    ...(verdict === "rejected" ? ([["rejected", null]] as Script) : []),
  ];
  const revised: Script = [
    ...lap("approved"),
    ["stage-all", cmd(true)],
    ["staged", cmd(true)],
    ["acceptance", { decision: "revise", replan: false, requests: "r" }],
    ["decision", null],
  ];

  it("counts rejections, not reviews", () => {
    expect(walk(quick, [...start, ...revised, ...revised, ...lap("rejected")])).toBe("node implementer");
    expect(walk(quick, [...start, ...lap("rejected"), ...lap("rejected"), ...lap("rejected")])).toBe("terminal review-stuck");
  });
});

describe("dev's objection check", () => {
  const dev = parse("dev");
  const upToPlan = planned.slice(0, 3);

  it("does not send a key with no objection beside it to a review that needs the objection", () => {
    // Null is what a model writes for an optional field, and it reads as absent.
    const keyOnly: Script = [...upToPlan, ["planner", { questions: "", plan: "p", planFile: "f", notes: "", conflictKey: "pq-kem", conflicts: null }], ["conflict-check", null]];
    expect(walk(dev, keyOnly)).toBe("node plan-check");
    const raised: Script = [
      ...upToPlan,
      ["planner", { questions: "", plan: "p", planFile: "f", notes: "", conflictKey: "pq-kem", conflicts: [{ conflictKey: "pq-kem" }] }],
      ["conflict-check", null],
    ];
    expect(walk(dev, raised)).toBe("node conflict-review");
  });
});
