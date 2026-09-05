import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { agentsDir } from "@/agents/registry";
import { parseWorkflow } from "@/workflows/loader";
import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow, workflowsDir } from "@/workflows/registry";

const meta = { sourcePath: "/tmp/x.yaml", updatedAt: 0 };

const PIPELINE = `
name: Dev pipeline
entry: planner
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation
  - id: implementation
    type: agent
    agent: implementation
    inputs: [planner.plan]
    next: tester
  - id: tester
    type: agent
    agent: tester
    edges:
      - when: outputs.tester.passed == true
        to: done
      - to: implementation
        label: retry
  - id: done
    type: terminal
`;

describe("parseWorkflow", () => {
  it("parses nodes, edges and defaults", () => {
    const wf = parseWorkflow("dev", PIPELINE, meta);
    expect(wf.name).toBe("Dev pipeline");
    expect(wf.maxWorkflowSteps).toBe(50);
    expect(wf.maxVisits).toBe(5);
    expect(wf.nodes).toHaveLength(4);
    const planner = wf.nodes.find((n) => n.id === "planner")!;
    expect(planner.edges).toEqual([{ to: "implementation", condition: null }]);
    const tester = wf.nodes.find((n) => n.id === "tester")!;
    expect(tester.edges[0].condition).not.toBeNull();
    expect(tester.edges[1].condition).toBeNull();
  });

  it("rejects invalid YAML", () => {
    expect(() => parseWorkflow("x", "name: [unclosed", meta)).toThrow(/invalid YAML/);
  });

  it("rejects an unknown entry node", () => {
    const src = "name: X\nentry: nope\nnodes:\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/entry node "nope" does not exist/);
  });

  it("rejects duplicate node ids", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: condition\n    edges: [{when: 'outputs.a.ok == true', to: a}]\n  - id: a\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/duplicate node id "a"/);
  });

  it("rejects an edge pointing at an unknown node", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    next: ghost\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/unknown node "ghost"/);
  });

  it("rejects a workflow with no terminal node", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    next: a\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/no terminal node/);
  });

  it("rejects unreachable nodes", () => {
    const src =
      "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    next: done\n  - id: orphan\n    type: agent\n    agent: p\n    next: done\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/unreachable node: orphan/);
  });

  it("rejects a node with no outgoing edge", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/no outgoing edge/);
  });

  it("rejects both next and edges on one node", () => {
    const src =
      "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    next: done\n    edges: [{to: done}]\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/not both/);
  });

  it("rejects a condition node without a conditional edge", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: condition\n    next: done\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/no conditional edge/);
  });

  it("rejects more than one fallback edge", () => {
    const src =
      "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    edges: [{to: done}, {to: done}]\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/more than one fallback edge/);
  });

  it("rejects a condition reading an unknown node output or an unknown root", () => {
    const bad = "name: X\nentry: a\nnodes:\n  - id: a\n    type: condition\n    edges: [{when: 'outputs.ghost.ok == true', to: done}, {to: done}]\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", bad, meta)).toThrow(/unknown node output "ghost"/);
    const root = "name: X\nentry: a\nnodes:\n  - id: a\n    type: condition\n    edges: [{when: 'env.SECRET == \"x\"', to: done}, {to: done}]\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", root, meta)).toThrow(/only "outputs" and "input" are available/);
  });

  it("reports a malformed condition expression", () => {
    const src = "name: X\nentry: a\nnodes:\n  - id: a\n    type: condition\n    edges: [{when: 'outputs.a.ok ==', to: done}, {to: done}]\n  - id: done\n    type: terminal\n";
    expect(() => parseWorkflow("x", src, meta)).toThrow(/node "a":/);
  });

  it("rejects an unknown agent reference when a checker is supplied", () => {
    expect(() => parseWorkflow("dev", PIPELINE, { ...meta, agentExists: (id) => id !== "tester" })).toThrow(
      /unknown agent "tester"/,
    );
  });
});

describe("workflow registry", () => {
  beforeEach(() => {
    mkdirSync(workflowsDir(), { recursive: true });
    mkdirSync(agentsDir(), { recursive: true });
    for (const id of ["planner", "implementation", "tester"]) {
      writeFileSync(join(agentsDir(), `${id}.md`), `---\nname: ${id}\n---\nDo the ${id} work.\n`);
    }
    for (const { id } of listWorkflows().workflows) deleteWorkflow(id);
  });

  it("round-trips a workflow through disk", () => {
    const saved = saveWorkflow("dev", PIPELINE);
    expect(saved.id).toBe("dev");
    expect(getWorkflow("dev").nodes).toHaveLength(4);
    expect(listWorkflows().workflows.map((w) => w.id)).toEqual(["dev"]);
    expect(deleteWorkflow("dev")).toBe(true);
    expect(deleteWorkflow("dev")).toBe(false);
  });

  it("never writes an invalid definition", () => {
    expect(() => saveWorkflow("broken", "name: X\nentry: nope\nnodes: []\n")).toThrow();
    expect(listWorkflows().workflows).toHaveLength(0);
  });

  it("rejects ids that could escape the workflows directory", () => {
    expect(() => getWorkflow("../../etc/passwd")).toThrow(/invalid workflow id/);
  });

  it("surfaces unparseable files instead of throwing on list", () => {
    writeFileSync(join(workflowsDir(), "bad.yaml"), "name: [unclosed\n");
    const { workflows, errors } = listWorkflows();
    expect(workflows).toHaveLength(0);
    expect(errors[0].id).toBe("bad");
    deleteWorkflow("bad");
  });
});

const PARALLEL = (nodes: string) => `
name: Parallel
entry: fan
nodes:
${nodes}
`;

describe("parallel validation", () => {
  const branches = `  - id: fan
    type: parallel
    branches: [a, b]
    join: join
  - id: a
    type: agent
    agent: planner
    next: join
  - id: b
    type: agent
    agent: planner
    next: join
  - id: join
    type: terminal`;

  it("accepts two independent branches meeting at a join", () => {
    const wf = parseWorkflow("p", PARALLEL(branches), meta);
    const fan = wf.nodes.find((n) => n.id === "fan");
    expect(fan?.type).toBe("parallel");
    expect(fan?.edges).toEqual([]);
  });

  it("rejects a branch that never reaches the join", () => {
    const raw = PARALLEL(branches.replace(
      "  - id: b\n    type: agent\n    agent: planner\n    next: join",
      "  - id: b\n    type: agent\n    agent: planner\n    next: b",
    ));
    expect(() => parseWorkflow("p", raw, meta)).toThrow(/never reaches the join node/);
  });

  it("rejects a branch that loops back into the main line", () => {
    const raw = `
name: Parallel
entry: start
nodes:
  - id: start
    type: agent
    agent: planner
    next: fan
  - id: fan
    type: parallel
    branches: [a, b]
    join: join
  - id: a
    type: agent
    agent: planner
    next: start
  - id: b
    type: agent
    agent: planner
    next: join
  - id: join
    type: terminal
`;
    // Following the branch leads back through the fan-out itself, so the
    // regions are no longer independent — whichever containment rule catches
    // it first, the definition is rejected.
    expect(() => parseWorkflow("p", raw, meta)).toThrow(/parallel node "fan"/);
  });

  it("rejects a terminal inside a branch", () => {
    const raw = PARALLEL(branches.replace("  - id: b\n    type: agent\n    agent: planner\n    next: join", "  - id: b\n    type: terminal"));
    expect(() => parseWorkflow("p", raw, meta)).toThrow(/ends the workflow/);
  });

  it("rejects a jump into a branch from outside", () => {
    const raw = `
name: Parallel
entry: start
nodes:
  - id: start
    type: condition
    edges:
      - when: input.skip == true
        to: a
      - to: fan
  - id: fan
    type: parallel
    branches: [a, b]
    join: join
  - id: a
    type: agent
    agent: planner
    next: join
  - id: b
    type: agent
    agent: planner
    next: join
  - id: join
    type: terminal
`;
    expect(() => parseWorkflow("p", raw, meta)).toThrow(/points into branch/);
  });

  it("rejects an unknown join and a branch that is also the join", () => {
    expect(() => parseWorkflow("p", PARALLEL(branches.replace("join: join", "join: nowhere")), meta)).toThrow(/unknown node "nowhere"/);
    expect(() => parseWorkflow("p", PARALLEL(branches.replace("branches: [a, b]", "branches: [a, join]")), meta)).toThrow(
      /join node/,
    );
  });

  it("rejects branches that share a node", () => {
    const raw = `
name: Parallel
entry: fan
nodes:
  - id: fan
    type: parallel
    branches: [a, b]
    join: join
  - id: a
    type: agent
    agent: planner
    next: shared
  - id: b
    type: agent
    agent: planner
    next: shared
  - id: shared
    type: agent
    agent: planner
    next: join
  - id: join
    type: terminal
`;
    expect(() => parseWorkflow("p", raw, meta)).toThrow(/both contain node "shared"/);
  });
});
