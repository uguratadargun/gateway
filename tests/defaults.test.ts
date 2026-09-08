import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, ensureDefaultAgents } from "@/agents/defaults";
import { agentsDir, deleteAgent, listAgents, saveAgent } from "@/agents/registry";
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

describe("what the shipped agents declare", () => {
  it("is a planner, an implementer and a reviewer, each following its skills", () => {
    ensureDefaultAgents();
    const byId = new Map(listAgents().agents.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual(["implementer", "planner", "reviewer"]);

    // The skills are the point of the defaults: without them these are three
    // ordinary prompts, and the processes somebody chose deliberately are gone.
    expect(byId.get("planner")!.skills).toEqual([
      "superpowers-brainstorming",
      "superpowers-using-git-worktrees",
      "superpowers-writing-plans",
    ]);
    expect(byId.get("implementer")!.skills).toContain("superpowers-test-driven-development");
    expect(byId.get("reviewer")!.skills).toEqual(["superpowers-requesting-code-review"]);

    // Only the implementer may change anything; the other two read.
    expect(byId.get("implementer")!.tools).toContain("write_file");
    expect(byId.get("reviewer")!.tools).not.toContain("write_file");
  });
});

describe("the shipped pipeline", () => {
  /**
   * The graph, exercised with stand-ins.
   *
   * The shipped agents run as a spawned Claude Code, which a test cannot
   * spawn, so three agents of the same names and output shapes stand in for
   * them. What is under test is the workflow: where a rejection goes, what
   * reaches the commit, and how the task travels into the merge request.
   */
  const STANDINS: Record<string, string> = {
    planner: `---
name: Planner
inputs: [reviewer.feedback?]
output:
  type: json
  schema:
    plan: string
    steps: "string[]"
---
Plan {{input.task}} {{inputs.reviewer.feedback}}
`,
    implementer: `---
name: Implementer
inputs: [planner.plan, planner.steps, reviewer.feedback?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Do {{inputs.planner.plan}}
`,
    reviewer: `---
name: Reviewer
inputs: [planner.plan, implementer.summary]
output:
  type: json
  schema:
    verdict: string
    feedback: "string?"
---
Review {{inputs.implementer.summary}}
`,
  };

  it("loops back to the planner on a rejected review, then commits and opens the merge request", async () => {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    const workflow = getWorkflow("dev");

    const visits: Record<string, number> = {};
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId ?? "";
      const visit = (visits[node] = (visits[node] ?? 0) + 1);
      switch (node) {
        case "planner":
          return JSON.stringify({ plan: `plan ${visit}`, steps: ["edit a.ts"] });
        case "implementer":
          return JSON.stringify({ summary: `pass ${visit}`, changed: true });
        case "reviewer":
          return visit === 1
            ? JSON.stringify({ verdict: "changes-requested", feedback: "Rename `x` to `count`." })
            : JSON.stringify({ verdict: "approved" });
        default:
          return "{}";
      }
    });

    // No worktree in a test, so the git nodes are answered rather than run —
    // and answering them is how the merge-request argv gets inspected.
    const ran: string[][] = [];
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      // A diff with content, or the run stops at "nothing changed".
      return { ok: true, exitCode: 0, stdout: node.id === "diff" ? "--- a.ts\n+++ a.ts\n" : "", stderr: "" };
    };

    const state = await runWorkflow(workflow, {
      provider,
      runCommand: runCommand as never,
      input: { task: "Add a thing" },
    });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Once, then again after the review sent it back — a rejection returns to
    // the planner, so the plan is revised rather than re-implemented blind.
    expect(state.visitCounts.planner).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);

    // The feedback reaches the planner's second pass, and nothing before it.
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[0]).not.toContain("Rename");
    expect(plans[1]).toContain("Rename `x` to `count`.");

    const mr = ran.find((c) => c[0] === "sh")!;
    expect(mr).toBeDefined();
    // The task is an argument, not part of the script: gate never builds a
    // shell string out of a run's own values, and a task is the most
    // user-written value there is.
    expect(mr.at(-1)).toBe("Add a thing");
    expect(mr[2]).not.toContain("Add a thing");
    expect(mr[2]).toContain("glab mr create");

    const commit = ran.find((c) => c[0] === "git" && c[1] === "commit")!;
    expect(commit).toContain("Add a thing");
    expect(commit).toContain("pass 2");
  });
});
