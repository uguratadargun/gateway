import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, ensureDefaultAgents } from "@/agents/defaults";
import { agentsDir, deleteAgent, listAgents } from "@/agents/registry";
import { runWorkflow } from "@/runtime/engine";
import { DEFAULT_WORKFLOWS, ensureDefaultWorkflows } from "@/workflows/defaults";
import { getWorkflow, listWorkflows, workflowsDir } from "@/workflows/registry";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/**
 * The shipped defaults are validated by the same loaders the UI uses, so a
 * change to the agent or workflow schema that the seeds no longer satisfy
 * fails here rather than on a user's first visit.
 */

const previousHome = process.env.GATE_HOME;

beforeAll(() => {
  process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-seed-"));
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

describe("seeded defaults", () => {
  it("writes agents and the sample workflow on first access", () => {
    ensureDefaultWorkflows();

    const { agents, errors } = listAgents();
    expect(errors).toEqual([]);
    expect(agents.map((a) => a.id).sort()).toEqual(Object.keys(DEFAULT_AGENTS).sort());

    const workflows = listWorkflows();
    expect(workflows.errors).toEqual([]);
    expect(workflows.workflows.map((w) => w.id).sort()).toEqual(Object.keys(DEFAULT_WORKFLOWS).sort());
  });

  it("does not resurrect a deleted default", () => {
    // Its own home, so the deletion does not leak into the pipeline run below.
    const home = process.env.GATE_HOME;
    process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-seed-"));
    try {
      ensureDefaultWorkflows();
      expect(deleteAgent("reviewer")).toBe(true);
      ensureDefaultAgents();
      expect(existsSync(join(agentsDir(), "reviewer.md"))).toBe(false);
      expect(existsSync(workflowsDir())).toBe(true);
    } finally {
      process.env.GATE_HOME = home;
    }
  });
});

describe("sample dev pipeline", () => {
  it("loops back to implementation on a failing test and a rejected review", async () => {
    ensureDefaultWorkflows();
    const workflow = getWorkflow("sample-dev-pipeline");

    // Tests fail once, then the review rejects once; everything passes after.
    const visits: Record<string, number> = {};
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId ?? "";
      const visit = (visits[node] = (visits[node] ?? 0) + 1);
      switch (node) {
        case "planner":
          return JSON.stringify({ plan: "Add the thing", steps: ["edit a.ts"], risks: [] });
        case "implementation":
          return JSON.stringify({ summary: `pass ${visit}`, diff: "--- a.ts\n+++ a.ts\n" });
        case "tester":
          return visit === 1
            ? JSON.stringify({ passed: false, failures: ["a.ts: off-by-one in the loop bound"] })
            : JSON.stringify({ passed: true, failures: [] });
        case "reviewer":
          return visit === 1
            ? JSON.stringify({ verdict: "rejected", findings: ["name the helper properly"], feedback: "Rename `x` to `count`." })
            : JSON.stringify({ verdict: "approved", findings: [] });
        default:
          return JSON.stringify({ verdict: "approved", findings: [] });
      }
    });

    const state = await runWorkflow(workflow, { provider, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Once for the plan, once after the failing test, once after the rejection.
    expect(state.visitCounts.implementation).toBe(3);
    // Review and security review run as one parallel step, joined at "verdict".
    expect(state.visitCounts.reviewer).toBe(2);
    expect(state.visitCounts.security).toBe(2);
    expect(state.history.at(-1)?.nodeId).toBe("verdict");

    const prompts = provider.callsFor("implementation").map((c) => c.messages[0].content);
    const [first, afterTests, afterReview] = prompts;
    // Optional feedback inputs render empty before their node has ever run,
    // and carry the upstream complaint verbatim on the retry.
    expect(first).not.toContain("off-by-one");
    expect(afterTests).toContain("off-by-one in the loop bound");
    expect(afterReview).toContain("Rename `x` to `count`.");
  });
});
