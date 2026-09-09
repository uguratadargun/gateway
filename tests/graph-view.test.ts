import { describe, expect, it } from "vitest";

import { autoLayout, toGraphNodes, type ApiWorkflowNode } from "@/workflows/graph-view";

/**
 * Tidy up puts the run's main line on one row, side exits above it and
 * return paths below it — because loops are drawn under the cards, and a
 * card placed under the spine sits on the loop.
 */

const node = (id: string, type: ApiWorkflowNode["type"], edges: Array<{ to: string; label?: string }> = []): ApiWorkflowNode => ({
  id,
  type,
  edges,
});

// The shape of the shipped pipeline, reduced to what the layout has to get right.
const DEV = toGraphNodes([
  node("base", "command", [{ to: "planner" }]),
  node("planner", "agent", [{ to: "plan-check" }]),
  node("plan-check", "condition", [{ to: "clarify" }, { to: "plan-review" }]),
  node("clarify", "agent", [{ to: "planner" }]),
  node("plan-review", "agent", [{ to: "plan-decision" }]),
  node("plan-decision", "condition", [{ to: "implementer" }, { to: "planner" }, { to: "awaiting-plan-approval" }]),
  node("implementer", "agent", [{ to: "nothing-changed" }, { to: "diff" }]),
  node("diff", "command", [{ to: "nothing-changed" }, { to: "reviewer" }]),
  node("reviewer", "agent", [{ to: "verdict" }]),
  node("verdict", "condition", [{ to: "done" }, { to: "review-stuck" }, { to: "planner" }]),
  node("done", "terminal"),
  node("nothing-changed", "terminal"),
  node("review-stuck", "terminal"),
  node("awaiting-plan-approval", "terminal"),
]);

describe("tidy up", () => {
  const layout = autoLayout(DEV, "base");

  it("puts the main line on one row, straight across", () => {
    for (const id of ["base", "planner", "plan-check", "plan-review", "plan-decision", "implementer", "diff", "reviewer", "verdict", "done"]) {
      expect(layout[id].y, id).toBe(0);
    }
    // Left to right, one column per step.
    expect(layout.planner.x).toBeGreaterThan(layout.base.x);
    expect(layout.verdict.x).toBeGreaterThan(layout.reviewer.x);
  });

  it("chooses the node with the longest road ahead as the spine, not the first one listed", () => {
    // diff lists nothing-changed before reviewer; reviewer still holds the row.
    expect(layout.reviewer.y).toBe(0);
    expect(layout["nothing-changed"].y).not.toBe(0);
  });

  it("puts side exits above the spine, where the return paths do not run", () => {
    for (const id of ["nothing-changed", "review-stuck", "awaiting-plan-approval"]) {
      expect(layout[id].y, id).toBeLessThan(0);
    }
  });

  it("puts a side node that loops back below the spine, so its return path leaves clear", () => {
    expect(layout.clarify.y).toBeGreaterThan(0);
    expect(layout.clarify.x).toBe(layout["plan-review"].x);
  });

  it("stacks several side nodes in a column apart from each other", () => {
    const shape = toGraphNodes([
      node("a", "command", [{ to: "b" }, { to: "x" }, { to: "y" }]),
      node("b", "command", [{ to: "done" }]),
      node("x", "terminal"),
      node("y", "terminal"),
      node("done", "terminal"),
    ]);
    const out = autoLayout(shape, "a");
    expect(out.b.y).toBe(0);
    expect(out.x.y).not.toBe(out.y.y);
    expect(out.x.x).toBe(out.y.x);
  });

  it("still places a node the entry cannot reach", () => {
    const out = autoLayout(toGraphNodes([node("a", "terminal"), node("orphan", "terminal")]), "a");
    expect(out.orphan).toBeDefined();
  });
});
