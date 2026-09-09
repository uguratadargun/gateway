import { describe, expect, it } from "vitest";

import { autoLayout, COLUMN_WIDTH, skipKeys, toGraphNodes, type ApiWorkflowNode } from "@/workflows/graph-view";
import { loopLinkKeys } from "@/workflows/routing";

/**
 * Tidy up puts the run's main line on one row, side exits above it and
 * return paths below it — because loops are drawn under the cards, and a
 * card placed under the spine sits on the loop.
 */

const node = (
  id: string,
  type: ApiWorkflowNode["type"],
  edges: Array<{ to: string; label?: string }> = [],
  status?: string,
): ApiWorkflowNode => ({
  id,
  type,
  edges,
  ...(status ? { status } : {}),
});

// The shape of the shipped pipeline, reduced to what the layout has to get right.
const DEV = toGraphNodes([
  node("base", "command", [{ to: "planner" }]),
  node("planner", "agent", [{ to: "plan-check" }]),
  // The shortcut: a plan already approved goes straight to the implementer.
  node("plan-check", "condition", [{ to: "clarify" }, { to: "implementer" }, { to: "plan-review" }]),
  node("clarify", "agent", [{ to: "planner" }]),
  node("plan-review", "agent", [{ to: "plan-decision" }]),
  node("plan-decision", "condition", [{ to: "implementer" }, { to: "planner" }, { to: "awaiting-plan-approval" }]),
  node("implementer", "agent", [{ to: "nothing-changed" }, { to: "diff" }]),
  node("diff", "command", [{ to: "nothing-changed" }, { to: "reviewer" }]),
  node("reviewer", "agent", [{ to: "verdict" }]),
  node("verdict", "condition", [{ to: "done" }, { to: "review-stuck" }, { to: "planner" }]),
  node("done", "terminal"),
  node("nothing-changed", "terminal", [], "failed"),
  node("review-stuck", "terminal", [], "failed"),
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

  it("lays columns by the longest road, so a shortcut never pulls a node back beside the gate it skips", () => {
    // plan-check reaches the implementer directly and through plan-review →
    // plan-decision; the implementer sits after the gate, not beside it.
    expect(layout.implementer.x).toBe(layout["plan-decision"].x + COLUMN_WIDTH);
    // And no forward edge points left: every non-loop edge goes to a column further on.
    const loops = loopLinkKeys(DEV, "base");
    for (const n of DEV) {
      for (const e of n.edges) {
        if (loops.has(`${n.id}->${e.to}`)) continue;
        expect(layout[e.to].x, `${n.id} → ${e.to}`).toBeGreaterThan(layout[n.id].x);
      }
    }
  });

  it("ends the main line on the happy terminal when a failed exit shares its column", () => {
    const shape = toGraphNodes([
      node("a", "condition", [{ to: "bad" }, { to: "ok" }]),
      node("bad", "terminal", [], "failed"),
      node("ok", "terminal"),
    ]);
    const out = autoLayout(shape, "a");
    expect(out.ok.y).toBe(0);
    expect(out.bad.y).toBeLessThan(0);
  });

  it("marks the edges that pass over columns, from where the cards are", () => {
    const loops = loopLinkKeys(DEV, "base");
    const skips = skipKeys(DEV, layout, loops);
    // The shortcut spans three columns; the step to the next column does not.
    expect(skips.has("plan-check->implementer")).toBe(true);
    expect(skips.has("plan-review->plan-decision")).toBe(false);
    // A return path is never a skip, whatever the distance.
    expect(skips.has("verdict->planner")).toBe(false);
    // A card dragged back to the left of its source turns that edge into one.
    const dragged = { ...layout, reviewer: { x: layout.diff.x - COLUMN_WIDTH, y: 200 } };
    expect(skipKeys(DEV, dragged, loops).has("diff->reviewer")).toBe(true);
  });

  it("still places a node the entry cannot reach", () => {
    const out = autoLayout(toGraphNodes([node("a", "terminal"), node("orphan", "terminal")]), "a");
    expect(out.orphan).toBeDefined();
  });
});
