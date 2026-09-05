import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { AgentDefinitionError, parseAgent, serializeAgent } from "@/agents/loader";
import { agentsDir, deleteAgent, getAgent, listAgents, saveAgent } from "@/agents/registry";
import { buildOutputSchema } from "@/agents/types";

const meta = { sourcePath: "/tmp/x.md", updatedAt: 0 };

const TESTER = `---
name: Tester
model: haiku
effort: low
inputs: [implementation.diff]
output:
  type: json
  schema:
    passed: boolean
    failures: number
    notes: string?
---
Run the tests for:

{{inputs.implementation.diff}}
`;

describe("parseAgent", () => {
  it("parses frontmatter and prompt body", () => {
    const def = parseAgent("tester", TESTER, meta);
    expect(def.name).toBe("Tester");
    expect(def.model).toBe("haiku");
    expect(def.effort).toBe("low");
    expect(def.inputs).toEqual(["implementation.diff"]);
    expect(def.output).toEqual({ type: "json", schema: { passed: "boolean", failures: "number", notes: "string?" } });
    expect(def.prompt).toContain("{{inputs.implementation.diff}}");
  });

  it("defaults model, inputs, tools and output when omitted", () => {
    const def = parseAgent("planner", "---\nname: Planner\n---\nPlan it.", meta);
    expect(def.model).toBe("sonnet");
    expect(def.inputs).toEqual([]);
    expect(def.tools).toEqual([]);
    expect(def.output).toEqual({ type: "text" });
  });

  it("rejects a file without frontmatter, without a body, or with unknown keys", () => {
    expect(() => parseAgent("a", "just a prompt", meta)).toThrow(AgentDefinitionError);
    expect(() => parseAgent("a", "---\nname: A\n---\n", meta)).toThrow(AgentDefinitionError);
    expect(() => parseAgent("a", "---\nname: A\nmodle: sonnet\n---\nx", meta)).toThrow(/invalid frontmatter/);
  });

  it("rejects an unknown output field type", () => {
    const raw = "---\nname: A\noutput:\n  type: json\n  schema:\n    ok: bool\n---\nx";
    expect(() => parseAgent("a", raw, meta)).toThrow(/unknown field type/);
  });

  it("rejects a prompt that reads an undeclared input", () => {
    const raw = "---\nname: A\ninputs: [planner.plan]\n---\n{{inputs.reviewer.verdict}}";
    expect(() => parseAgent("a", raw, meta)).toThrow(/undeclared input/);
  });

  it("round-trips through serializeAgent", () => {
    const md = serializeAgent({ name: "Planner", model: "sonnet", inputs: [] }, "Plan it.");
    expect(parseAgent("planner", md, meta).name).toBe("Planner");
  });
});

describe("buildOutputSchema", () => {
  it("validates a declared json shape and keeps extra keys", () => {
    const schema = buildOutputSchema({ type: "json", schema: { passed: "boolean", notes: "string?" } });
    expect(schema.parse({ passed: true, extra: 1 })).toEqual({ passed: true, extra: 1 });
    expect(schema.safeParse({ passed: "yes" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("validates text output as a plain string", () => {
    expect(buildOutputSchema({ type: "text" }).parse("hello")).toBe("hello");
  });
});

describe("registry", () => {
  beforeEach(() => {
    mkdirSync(agentsDir(), { recursive: true });
    for (const { id } of listAgents().agents) deleteAgent(id);
  });

  it("saves, reads back, lists and deletes", () => {
    const saved = saveAgent("tester", TESTER);
    expect(saved.id).toBe("tester");
    expect(getAgent("tester").name).toBe("Tester");
    expect(listAgents().agents.map((a) => a.id)).toEqual(["tester"]);
    expect(deleteAgent("tester")).toBe(true);
    expect(listAgents().agents).toEqual([]);
  });

  it("never writes an invalid definition to disk", () => {
    expect(() => saveAgent("broken", "no frontmatter here")).toThrow(AgentDefinitionError);
    expect(listAgents().agents).toEqual([]);
  });

  it("reports unparseable files instead of failing the whole listing", () => {
    saveAgent("tester", TESTER);
    writeFileSync(join(agentsDir(), "broken.md"), "nope");
    const { agents, errors } = listAgents();
    expect(agents.map((a) => a.id)).toEqual(["tester"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe("broken");
  });

  it("refuses ids that could escape the agents directory", () => {
    expect(() => getAgent("../../etc/passwd")).toThrow(AgentDefinitionError);
  });
});
