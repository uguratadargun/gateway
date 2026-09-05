import { describe, expect, it } from "vitest";

import { parseWorkflow } from "@/workflows/loader";
import { toWorkflowYaml, workflowGraphDocSchema } from "@/workflows/serialize";

/**
 * The visual editor posts a graph and the server writes the file, so the only
 * thing that matters here is that the YAML it produces parses back into the
 * same graph — and that a half-built graph still fails validation.
 */

const meta = { sourcePath: "/tmp/x.yaml", updatedAt: 0 };

const RICH = `
name: Dev pipeline
description: Plan, implement, review.
entry: planner
workspace:
  repo: /tmp/repo
  baseRef: main
maxWorkflowSteps: 40
maxVisits: 4
nodes:
  - id: planner
    type: agent
    agent: planner
    label: Plan
    inputs: [input.task]
    next: implementation
  - id: implementation
    type: agent
    agent: implementation
    next: tests
  - id: tests
    type: command
    command: [npm, test]
    cwd: packages/core
    timeoutMs: 60000
    edges:
      - when: outputs.tests.ok == true
        to: checks
        label: tests pass
      - to: implementation
  - id: checks
    type: parallel
    label: Reviews
    branches: [reviewer, security]
    join: verdict
  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict
  - id: security
    type: agent
    agent: reviewer
    next: verdict
  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: done
      - to: implementation
  - id: done
    type: terminal
    status: completed
`;

/** Everything the engine cares about, with the parse-time extras dropped. */
function shape(source: string) {
  const wf = parseWorkflow("wf", source, meta);
  return {
    name: wf.name,
    description: wf.description,
    entry: wf.entry,
    workspace: wf.workspace,
    maxWorkflowSteps: wf.maxWorkflowSteps,
    maxVisits: wf.maxVisits,
    nodes: wf.nodes.map((n) => ({ ...n, edges: n.edges.map((e) => ({ to: e.to, when: e.when, label: e.label })) })),
  };
}

function roundTrip(source: string): string {
  const wf = parseWorkflow("wf", source, meta);
  return toWorkflowYaml(workflowGraphDocSchema.parse(wf));
}

describe("workflow serialization", () => {
  it("round-trips a workflow through the graph document", () => {
    const again = roundTrip(RICH);
    expect(shape(again)).toEqual(shape(RICH));
  });

  it("is stable: serializing twice changes nothing", () => {
    const once = roundTrip(RICH);
    expect(roundTrip(once)).toBe(once);
  });

  it("writes a single plain edge as next: sugar", () => {
    expect(roundTrip(RICH)).toContain("next: implementation");
  });

  it("accepts nodes exactly as the API hands them over", () => {
    // The API's edges carry a parsed condition tree; it must be dropped rather
    // than rejected, or the editor could never save what it was given.
    const doc = workflowGraphDocSchema.parse({
      name: "Tiny",
      entry: "start",
      nodes: [
        { id: "start", type: "condition", edges: [{ when: "input.go == true", to: "done", condition: { kind: "op" } }] },
        { id: "done", type: "terminal", status: "completed", edges: [] },
      ],
    });
    const yaml = toWorkflowYaml(doc);
    expect(yaml).not.toContain("condition:");
    expect(shape(yaml).nodes[0].edges).toEqual([{ to: "done", when: "input.go == true", label: undefined }]);
  });

  it("drops fields the editor left blank", () => {
    const yaml = toWorkflowYaml(
      workflowGraphDocSchema.parse({
        name: "Tiny",
        description: "",
        entry: "start",
        nodes: [
          { id: "start", type: "command", command: ["true"], cwd: "", label: "", next: "done" },
          { id: "done", type: "terminal", status: "completed" },
        ],
      }),
    );
    expect(yaml).not.toContain("cwd:");
    expect(yaml).not.toContain("label:");
    expect(yaml).not.toContain("workspace:");
    expect(yaml).not.toContain("description:");
  });

  // Clearing the repository field means "ask the run which repository", not
  // "take the agents' tools away", so the declaration has to survive the trip.
  it("keeps a workspace that pins no repository", () => {
    const doc = workflowGraphDocSchema.parse({
      name: "Tiny",
      entry: "start",
      workspace: { repo: "" },
      nodes: [
        { id: "start", type: "command", command: ["true"], next: "done" },
        { id: "done", type: "terminal", status: "completed" },
      ],
    });
    const yaml = toWorkflowYaml(doc);
    expect(yaml).toContain("workspace: {}");
    const parsed = parseWorkflow("tiny", yaml, meta);
    expect(parsed.workspace).toEqual({});
  });

  it("still fails validation for a half-built graph", () => {
    const yaml = toWorkflowYaml(
      workflowGraphDocSchema.parse({
        name: "Tiny",
        entry: "fan",
        nodes: [
          { id: "fan", type: "parallel", branches: [], join: "" },
          { id: "done", type: "terminal", status: "completed" },
        ],
      }),
    );
    expect(() => parseWorkflow("wf", yaml, meta)).toThrow(/branches/);
  });
});
