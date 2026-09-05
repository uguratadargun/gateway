import { describe, expect, it } from "vitest";

import { toGraphNodes } from "@/workflows/graph-view";
import { parseWorkflow } from "@/workflows/loader";
import {
  decisionPoints,
  incomingLinks,
  linkBetween,
  loopLinkKeys,
  outgoingLinks,
  takenLinks,
} from "@/workflows/routing";

/** The shape of the seeded repo-dev-team pipeline: a loop with a parallel fan-out. */
const TEAM = `
name: Repo dev team
entry: planner
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
    command: [npm, test]
    edges:
      - when: outputs.tests.ok == true
        to: checks
        label: tests pass
      - to: implementation
        label: tests failed
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
    agent: security-reviewer
    next: verdict
  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: done
        label: approved
      - to: implementation
        label: changes requested
  - id: done
    type: terminal
`;

const nodes = parseWorkflow("team", TEAM, { sourcePath: "/tmp/x.yaml", updatedAt: 0 }).nodes;

describe("routing view of a workflow", () => {
  it("routes a parallel node through its branches and its join", () => {
    const checks = nodes.find((n) => n.id === "checks")!;
    expect(outgoingLinks(checks)).toEqual([
      { from: "checks", to: "reviewer", kind: "branch" },
      { from: "checks", to: "security", kind: "branch" },
      { from: "checks", to: "verdict", kind: "join" },
    ]);
  });

  it("marks the edges that hand control back, and only those", () => {
    const loops = loopLinkKeys(nodes, "planner");
    expect([...loops].sort()).toEqual(["tests->implementation", "verdict->implementation"]);
    // A branch meeting its join moves the run forward, even though the join is
    // reached from the fan-out as well; it must not read as a return path.
    expect(loops).not.toContain("reviewer->verdict");
    expect(loops).not.toContain("security->verdict");
    expect(loops).not.toContain("checks->verdict");
  });

  it("counts a node that points at itself as a loop", () => {
    const selfLoop = parseWorkflow(
      "self",
      `
name: Self
entry: work
nodes:
  - id: work
    type: condition
    edges:
      - when: input.again == true
        to: work
      - to: done
  - id: done
    type: terminal
`,
      { sourcePath: "/tmp/x.yaml", updatedAt: 0 },
    ).nodes;
    expect([...loopLinkKeys(selfLoop, "work")]).toEqual(["work->work"]);
  });

  it("keeps seeing the loops once the graph is collapsed for the canvas", () => {
    // The canvas draws a parallel node's branches as its edges. Without the
    // branches and join riding along, the walk stopped at the fan-out and
    // everything past it — including "verdict → implementation" — lost its
    // depth, so the return path was drawn as an ordinary forward edge.
    const specs = toGraphNodes(nodes);
    expect(specs.find((n) => n.id === "checks")).toMatchObject({ branches: ["reviewer", "security"], join: "verdict" });
    expect([...loopLinkKeys(specs, "planner")].sort()).toEqual(["tests->implementation", "verdict->implementation"]);
  });

  it("lists everything that leads to a node", () => {
    expect(incomingLinks(nodes, "implementation")).toEqual([
      { from: "planner", to: "implementation", label: undefined, when: undefined, kind: "fallback" },
      { from: "tests", to: "implementation", label: "tests failed", when: undefined, kind: "fallback" },
      { from: "verdict", to: "implementation", label: "changes requested", when: undefined, kind: "fallback" },
    ]);
  });

  it("finds the nodes where the engine actually chooses", () => {
    expect(decisionPoints(nodes).map((d) => d.node.id)).toEqual(["tests", "checks", "verdict"]);
  });

  it("names the link a run took, and stays quiet when the graph is ambiguous", () => {
    expect(linkBetween(nodes, "verdict", "implementation")?.label).toBe("changes requested");
    expect(linkBetween(nodes, "planner", "tests")).toBeNull();

    const twoWays = parseWorkflow(
      "amb",
      `
name: Ambiguous
entry: start
nodes:
  - id: start
    type: condition
    edges:
      - when: input.go == true
        to: done
        label: go
      - to: done
        label: stop
  - id: done
    type: terminal
`,
      { sourcePath: "/tmp/x.yaml", updatedAt: 0 },
    ).nodes;
    expect(linkBetween(twoWays, "start", "done")).toBeNull();
  });

  it("reads the path a run took, even when parallel branches interleave", () => {
    // checks fans out; the steps arrive as reviewer, security, verdict, so the
    // link out of "reviewer" has to be found by looking forward, not next door.
    const run = ["planner", "implementation", "tests", "checks", "reviewer", "security", "verdict", "implementation"];
    const taken = takenLinks(nodes, run).map((links) => links.map((l) => `${l.from}->${l.to}`));
    expect(taken).toEqual([
      ["planner->implementation"],
      ["implementation->tests"],
      ["tests->checks"],
      ["checks->reviewer", "checks->security", "checks->verdict"],
      ["reviewer->verdict"],
      ["security->verdict"],
      ["verdict->implementation"],
      [],
    ]);
  });

  it("says nothing about the last step of a run that stopped", () => {
    expect(takenLinks(nodes, ["planner", "implementation"])[1]).toEqual([]);
  });

  it("recovers the final decision from how the run ended", () => {
    const run = ["planner", "implementation", "tests", "checks", "reviewer", "security", "verdict"];
    // A terminal node never runs, so nothing in the step list points at "done".
    expect(takenLinks(nodes, run).at(-1)).toEqual([]);
    expect(takenLinks(nodes, run, "completed").at(-1)).toEqual([
      { from: "verdict", to: "done", label: "approved", when: 'outputs.reviewer.verdict == "approved"', kind: "conditional" },
    ]);
    // Nothing to infer when the run ended somewhere without a matching terminal.
    expect(takenLinks(nodes, run, "failed").at(-1)).toEqual([]);
  });
});
