import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/executions/[id]/stream/route";
import { parseAgent } from "@/agents/loader";
import { newAgentTemplate } from "@/agents/new-agent-template";
import { renderTemplate, templatePaths } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";
import { publishWorkflowEvent, subscribeWorkflow, workflowEvents } from "@/events/bus";
import { runWorkflow } from "@/runtime/engine";
import { parseCondition, evaluateCondition } from "@/workflows/condition";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { parseWorkflow } from "@/workflows/loader";
import { getWorkflow, listWorkflows, saveWorkflow, workflowsDir } from "@/workflows/registry";

import { FakeModelProvider } from "./fakes/fake-model-provider";

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };

describe("new agent template", () => {
  it("is a definition the validator accepts", () => {
    const def = parseAgent("scout", newAgentTemplate("scout"), meta);
    expect(def.name).toBe("scout");
    expect(def.inputs).toEqual([]);
  });
});

describe("dashed node ids", () => {
  it("are readable from conditions and prompts", () => {
    const ctx = { outputs: { "security-review": { ok: true } }, input: {} };
    expect(evaluateCondition(parseCondition("outputs.security-review.ok == true"), ctx)).toBe(true);
    expect(templatePaths("{{inputs.security-review.findings}}")).toEqual(["inputs.security-review.findings"]);
    expect(renderTemplate("{{inputs.security-review.findings}}", { inputs: { "security-review": { findings: "none" } } })).toBe(
      "none",
    );
  });

  it("work end to end in a workflow", () => {
    const wf = parseWorkflow(
      "dashes",
      `
name: Dashes
entry: run-tests
nodes:
  - id: run-tests
    type: agent
    agent: planner
    edges:
      - when: outputs.run-tests.ok == true
        to: done
      - to: done
  - id: done
    type: terminal
`,
      meta,
    );
    expect(wf.nodes[0].edges[0].when).toBe("outputs.run-tests.ok == true");
  });
});

describe("workflow files ending in .yml", () => {
  it("can be opened and run, not just listed", () => {
    mkdirSync(workflowsDir(), { recursive: true });
    writeFileSync(
      join(workflowsDir(), "legacy.yml"),
      `
name: Legacy
entry: done
nodes:
  - id: done
    type: terminal
`,
    );
    expect(listWorkflows().workflows.map((w) => w.id)).toContain("legacy");
    expect(getWorkflow("legacy").name).toBe("Legacy");
    // Saving an existing .yml keeps its own file rather than forking a .yaml.
    expect(saveWorkflow("legacy", "name: Legacy 2\nentry: done\nnodes:\n  - id: done\n    type: terminal\n").name).toBe(
      "Legacy 2",
    );
    expect(getWorkflow("legacy").sourcePath.endsWith("legacy.yml")).toBe(true);
  });
});

describe("event bus eviction", () => {
  it("evicts old topics even while one execution is being watched", () => {
    const watched = "watched-run";
    publishWorkflowEvent({ type: "workflow.started", executionId: watched, at: 1, workflowId: "w", entry: "a" });
    const unsub = subscribeWorkflow(watched, () => {});
    for (let i = 0; i < 80; i++) {
      publishWorkflowEvent({ type: "workflow.started", executionId: `run-${i}`, at: 2 + i, workflowId: "w", entry: "a" });
    }
    // The watched topic survives; the unwatched backlog does not grow forever.
    expect(workflowEvents(watched)).toHaveLength(1);
    expect(workflowEvents("run-0")).toHaveLength(0);
    unsub();
  });
});

describe("run input requirements", () => {
  const AGENTS: Record<string, string> = {
    planner: "---\nname: Planner\n---\nPlan {{input.task}} for {{input.repo}}.\n",
    worker: "---\nname: Worker\ninputs: [input.branch]\n---\nWork.\n",
  };
  const loadAgent = (id: string): AgentDefinition => parseAgent(id, AGENTS[id], meta);

  const wf = () =>
    parseWorkflow(
      "w",
      `
name: W
entry: plan
nodes:
  - id: plan
    type: agent
    agent: planner
    next: work
  - id: work
    type: agent
    agent: worker
    next: done
  - id: done
    type: terminal
`,
      meta,
    );

  it("collects every input.* key a workflow reads", () => {
    expect(requiredRunInputs(wf(), loadAgent)).toEqual(["branch", "repo", "task"]);
  });

  it("reports the keys a run was started without", () => {
    expect(missingRunInputs(["task", "repo"], { task: "do it" })).toEqual(["repo"]);
    expect(missingRunInputs(["task"], { task: "" })).toEqual(["task"]);
    expect(missingRunInputs(["task"], { task: "do it" })).toEqual([]);
  });
});

describe("truncated agent output", () => {
  const AGENT = "---\nname: Big\nmaxTokens: 2048\noutput:\n  type: json\n  schema:\n    summary: string\n---\nWrite it.\n";
  const loadAgent = (id: string): AgentDefinition => parseAgent(id, AGENT, meta);
  const WORKFLOW = `
name: One
entry: write
nodes:
  - id: write
    type: agent
    agent: big
    next: done
  - id: done
    type: terminal
`;

  it("is reported as truncation, not as a formatting failure", async () => {
    const provider = new FakeModelProvider(() => ({ text: '{"summary": "half a sen', stopReason: "max_tokens" }));
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), { provider, loadAgent });
    expect(state.error?.code).toBe("AGENT_OUTPUT_TRUNCATED");
    expect(state.error?.message).toMatch(/2048 max tokens/);
    // The agent's own ceiling is what gets sent upstream.
    expect(provider.calls[0].maxTokens).toBe(2048);
  });
});

describe("execution stream", () => {
  it("closes instead of hanging when the run already finished", async () => {
    const id = "finished-run";
    publishWorkflowEvent({ type: "workflow.started", executionId: id, at: 1, workflowId: "w", entry: "a" });
    publishWorkflowEvent({ type: "workflow.completed", executionId: id, at: 2, status: "completed", terminalNodeId: "done" });

    const res = await GET(new Request("http://localhost/api/executions/finished-run/stream"), {
      params: Promise.resolve({ id }),
    });
    // A leaked heartbeat timer and listener used to keep this body open forever.
    const body = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stream never closed")), 2000)),
    ]);
    expect(body).toContain('"type":"workflow.started"');
    expect(body).toContain('"type":"workflow.completed"');
  });
});
