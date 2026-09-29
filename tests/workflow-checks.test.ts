import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentsDir } from "@/agents/registry";
import { renderTemplate, templatePaths } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";
import { evaluateCondition, parseCondition } from "@/workflows/condition";
import { optionalRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { parseWorkflow } from "@/workflows/loader";
import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow, workflowsDir } from "@/workflows/registry";
import { toWorkflowYaml, workflowGraphDocSchema } from "@/workflows/serialize";

/**
 * What a workflow file is refused for, or kept as, before any run walks it.
 * Each of these was a graph or a save that loaded fine and then went wrong in
 * the middle of a run — a loop with no way out, a guard that could only throw,
 * a Save that changed a command nobody touched.
 */

const meta = { sourcePath: "/tmp/x.yaml", updatedAt: 0 };

describe("the loader", () => {
  it("refuses a loop no node in which can reach a terminal", () => {
    const trapped = `
name: X
entry: s
nodes:
  - id: s
    type: condition
    edges:
      - when: outputs.a.ok == true
        to: done
      - to: a
  - id: a
    type: command
    command: ["true"]
    next: b
  - id: b
    type: command
    command: ["true"]
    next: a
  - id: done
    type: terminal
`;
    expect(() => parseWorkflow("x", trapped, meta)).toThrow(/a, b can never reach a terminal/);
    // The same loop with a give-up edge out of it loads.
    expect(() =>
      parseWorkflow(
        "x",
        trapped.replace("    next: a\n", "    edges:\n      - when: visits.b >= 3\n        to: done\n      - to: a\n"),
        meta,
      ),
    ).not.toThrow();
  });

  it("refuses a guard that reads a whole root", () => {
    const src = (when: string) => `
name: X
entry: a
nodes:
  - id: a
    type: command
    command: ["true"]
    edges:
      - when: ${when}
        to: done
      - to: done
  - id: done
    type: terminal
`;
    expect(() => parseWorkflow("x", src("visits >= 3"), meta)).toThrow(/reads "visits" whole/);
    expect(() => parseWorkflow("x", src("outputs"), meta)).toThrow(/reads "outputs" whole/);
  });

  it("refuses a guard that reads the output of a node that has none", () => {
    const src = `
name: X
entry: a
nodes:
  - id: a
    type: condition
    edges:
      - when: outputs.a.x == 1
        to: done
      - to: done
  - id: done
    type: terminal
`;
    expect(() => parseWorkflow("x", src, meta)).toThrow(/output of condition node "a", which has none/);
  });

  it("refuses a node input that reads a node the workflow does not have, unless it is optional", () => {
    const src = (input: string) => `
name: X
entry: a
nodes:
  - id: a
    type: agent
    agent: p
    inputs: [${input}]
    next: done
  - id: done
    type: terminal
`;
    expect(() => parseWorkflow("x", src("ghost.plan"), meta)).toThrow(/reads node "ghost"/);
    expect(() => parseWorkflow("x", src("visits.ghost"), meta)).toThrow(/reads node "ghost"/);
    expect(() => parseWorkflow("x", src("ghost.plan?"), meta)).not.toThrow();
    expect(() => parseWorkflow("x", src("input.task"), meta)).not.toThrow();
  });
});

describe("a node id that starts with a digit", () => {
  it("can be named in a condition", () => {
    expect(evaluateCondition(parseCondition("outputs.2fa.ok == true"), { outputs: { "2fa": { ok: true } } })).toBe(true);
    // A number is still a number.
    expect(evaluateCondition(parseCondition("visits.a >= 2.5"), { visits: { a: 3 } })).toBe(true);
  });

  it("can be named in a template", () => {
    expect(templatePaths("x {{inputs.2fa.ok}} y")).toEqual(["inputs.2fa.ok"]);
    expect(renderTemplate("x {{inputs.2fa.ok}} y", { inputs: { "2fa": { ok: "yes" } } })).toBe("x yes y");
  });
});

describe("saving a graph", () => {
  const save = (node: Record<string, unknown>) =>
    parseWorkflow(
      "x",
      toWorkflowYaml(
        workflowGraphDocSchema.parse({
          name: "X",
          entry: "a",
          nodes: [{ ...node, id: "a", next: "done" }, { id: "done", type: "terminal", status: "completed" }],
        }),
      ),
      meta,
    ).nodes[0];

  it("keeps a command's arguments exactly, whitespace included", () => {
    const node = save({ type: "command", command: ["tr", "-d", " ", "x "] });
    expect(node.type === "command" && node.command).toEqual(["tr", "-d", " ", "x "]);
  });

  it("keeps a node's explicit empty inputs, which is not the same as none", () => {
    const empty = save({ type: "agent", agent: "p", inputs: [] });
    expect(empty.type === "agent" && empty.inputs).toEqual([]);
    const none = save({ type: "agent", agent: "p" });
    expect(none.type === "agent" && none.inputs).toBeUndefined();
  });
});

describe("the workflow cache", () => {
  it("does not keep serving a workflow whose agent was deleted", () => {
    mkdirSync(workflowsDir(), { recursive: true });
    mkdirSync(agentsDir(), { recursive: true });
    for (const { id } of listWorkflows().workflows) deleteWorkflow(id);
    writeFileSync(join(agentsDir(), "gone.md"), "---\nname: gone\n---\nDo it.\n");
    saveWorkflow("uses-gone", "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: gone\n    next: done\n  - id: done\n    type: terminal\n");
    expect(getWorkflow("uses-gone").nodes).toHaveLength(2);

    rmSync(join(agentsDir(), "gone.md"));
    expect(() => getWorkflow("uses-gone")).toThrow(/unknown agent "gone"/);
    deleteWorkflow("uses-gone");
  });
});

describe("run inputs", () => {
  it("does not require an input an agent declares as optional", () => {
    const wf = parseWorkflow("x", "name: X\nentry: a\nnodes:\n  - id: a\n    type: agent\n    agent: p\n    next: done\n  - id: done\n    type: terminal\n", meta);
    const agent = { id: "p", prompt: "Do {{inputs.input.mode}}.", inputs: ["input.mode?"] } as unknown as AgentDefinition;
    expect(requiredRunInputs(wf, () => agent)).not.toContain("mode");
    expect(optionalRunInputs(wf, () => agent)).toContain("mode");
  });
});
