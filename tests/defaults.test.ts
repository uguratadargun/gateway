import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, ensureDefaultAgents, writeMissingDefaultAgents } from "@/agents/defaults";
import { agentExists, agentsDir, deleteAgent, listAgents, saveAgent } from "@/agents/registry";
import { teamScope } from "@/lib/def-root";
import { runWorkflow } from "@/runtime/engine";
import type { WorkflowEvent } from "@/events/types";
import { DEFAULT_WORKFLOWS, ensureDefaultWorkflows, writeMissingDefaultWorkflows } from "@/workflows/defaults";
import { deleteWorkflow, getWorkflow, listWorkflows, workflowsDir } from "@/workflows/registry";

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

describe("restoring the shipped definitions", () => {
  it("counts what a team inherits from the default team as present", () => {
    const home = process.env.GATE_HOME;
    process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-seed-"));
    try {
      ensureDefaultWorkflows();
      const ulak = teamScope("ulak");
      // The team owns nothing, and is missing nothing: the house library is
      // reachable through the fallback, and a copy would only shadow it.
      expect(Object.keys(DEFAULT_AGENTS).filter((id) => !agentExists(id, ulak))).toEqual([]);
      expect(writeMissingDefaultAgents(ulak)).toEqual([]);
      expect(writeMissingDefaultWorkflows(ulak)).toEqual([]);
      expect(existsSync(join(ulak.root, "agents"))).toBe(false);

      // Once the default team has lost one, the team really is missing it,
      // and restoring writes it into the team's own directory — never the
      // default team's, which is not this scope's to write.
      expect(deleteWorkflow("dev")).toBe(true);
      expect(writeMissingDefaultWorkflows(ulak)).toEqual(["dev"]);
      expect(existsSync(join(ulak.root, "workflows", "dev.yaml"))).toBe(true);
      expect(existsSync(join(teamScope().root, "workflows", "dev.yaml"))).toBe(false);
      expect(writeMissingDefaultWorkflows(ulak)).toEqual([]);
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
    expect(byId.get("implementer")!.skills).toContain("superpowers-subagent-driven-development");
    expect(byId.get("reviewer")!.skills).toEqual(["superpowers-requesting-code-review"]);

    // The planner writes the plan file its skills produce and runs the
    // worktree setup; only the implementer edits code; the reviewer reads.
    expect(byId.get("planner")!.tools).toContain("write_file");
    expect(byId.get("planner")!.tools).not.toContain("edit_file");
    expect(byId.get("implementer")!.tools).toContain("edit_file");
    expect(byId.get("reviewer")!.tools).not.toContain("write_file");
    expect(byId.get("reviewer")!.tools).not.toContain("edit_file");

    // The reviewer is handed the run's base and the diff against it, because
    // its skill reviews a git range and the implementer's skills commit as
    // they go — a reviewer left to run `git diff` would see nothing.
    expect(byId.get("reviewer")!.inputs).toContain("base.stdout");
    expect(byId.get("reviewer")!.inputs).toContain("diff.stdout");
    // The implementer takes the plan file, which is what its skills execute.
    expect(byId.get("implementer")!.inputs).toContain("planner.planFile");

    // Every agent carries an explicit timeout, the implementer a longer one.
    expect(byId.get("planner")!.timeoutMs).toBe(3_600_000);
    expect(byId.get("reviewer")!.timeoutMs).toBe(3_600_000);
    expect(byId.get("implementer")!.timeoutMs).toBeGreaterThan(3_600_000);
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
inputs: [reviewer.feedback?, implementer.summary?]
output:
  type: json
  schema:
    plan: string
    planFile: string
---
Plan {{input.task}} {{inputs.reviewer.feedback}} {{inputs.implementer.summary}}
`,
    implementer: `---
name: Implementer
inputs: [planner.plan, planner.planFile, reviewer.feedback?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Do {{inputs.planner.planFile}}
`,
    reviewer: `---
name: Reviewer
inputs: [base.stdout, diff.stdout, planner.plan, implementer.summary]
output:
  type: json
  schema:
    verdict: string
    feedback: "string?"
---
Review {{inputs.diff.stdout}} from {{inputs.base.stdout}}
`,
  };

  const BASE = "0123456789abcdef0123456789abcdef01234567";

  /** Which terminal a run ended on, from the event the engine emits for it. */
  function terminalOf(events: WorkflowEvent[]): string | undefined {
    const done = events.find((e) => e.type === "workflow.completed");
    return done && "terminalNodeId" in done ? done.terminalNodeId : undefined;
  }

  /** The git nodes, answered rather than run: no worktree in a test. */
  function fakeGit(opts: { staged: boolean; changed?: boolean }) {
    const ran: string[][] = [];
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      switch (node.id) {
        case "base":
          return { ok: true, exitCode: 0, stdout: BASE, stderr: "" };
        case "diff":
          // A diff with content, or the run stops at "nothing changed".
          return { ok: true, exitCode: 0, stdout: opts.changed === false ? "" : "--- a.ts\n+++ a.ts\n", stderr: "" };
        case "staged":
          // `git diff --cached --quiet` exits 1 when there is something to commit.
          return opts.staged
            ? { ok: false, exitCode: 1, stdout: "", stderr: "" }
            : { ok: true, exitCode: 0, stdout: "", stderr: "" };
        default:
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
    };
    return { ran, runCommand: runCommand as never };
  }

  function fakeTeam(reviews: (visit: number) => string) {
    const visits: Record<string, number> = {};
    return new FakeModelProvider((req) => {
      const node = req.context?.nodeId ?? "";
      const visit = (visits[node] = (visits[node] ?? 0) + 1);
      switch (node) {
        case "planner":
          return JSON.stringify({ plan: `plan ${visit}`, planFile: "docs/superpowers/plans/2026-09-08-thing.md" });
        case "implementer":
          return JSON.stringify({ summary: `pass ${visit}`, changed: true });
        case "reviewer":
          return reviews(visit);
        default:
          return "{}";
      }
    });
  }

  it("loops back to the planner on a rejected review, then commits and opens the merge request", async () => {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    const workflow = getWorkflow("dev");

    const provider = fakeTeam((visit) =>
      visit === 1
        ? JSON.stringify({ verdict: "changes-requested", feedback: "Rename `x` to `count`." })
        : JSON.stringify({ verdict: "approved" }),
    );
    const { ran, runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Once, then again after the review sent it back — a rejection returns to
    // the planner, so the plan is revised rather than re-implemented blind.
    expect(state.visitCounts.planner).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    // The base is recorded once, before anything runs, and never again.
    expect(state.visitCounts.base).toBe(1);

    // The feedback reaches the planner's second pass, and nothing before it.
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[0]).not.toContain("Rename");
    expect(plans[1]).toContain("Rename `x` to `count`.");

    // The reviewer is handed the base commit; the diff node diffs against it.
    const reviews = provider.callsFor("reviewer").map((c) => c.messages[0].content);
    expect(reviews[0]).toContain(BASE);
    const diff = ran.find((c) => c[0] === "git" && c[1] === "diff" && c.length === 3)!;
    expect(diff).toEqual(["git", "diff", BASE]);

    const mr = ran.find((c) => c[0] === "sh")!;
    expect(mr).toBeDefined();
    // The task is an argument, not part of the script: gate never builds a
    // shell string out of a run's own values, and a task is the most
    // user-written value there is.
    expect(mr.at(-1)).toBe("Add a thing");
    expect(mr[2]).not.toContain("Add a thing");
    expect(mr[2]).toContain("glab mr create");
    // glab is used only when it is signed in: a revoked token found after the
    // push has happened leaves the push-option route nothing to push.
    expect(mr[2]).toContain("glab auth status");
    expect(mr[2]).toContain("merge_request.create");

    const commit = ran.find((c) => c[0] === "git" && c[1] === "commit")!;
    expect(commit).toContain("Add a thing");
    expect(commit).toContain("pass 2");
  });

  it("skips the commit when the implementer's skills already committed everything", async () => {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    const workflow = getWorkflow("dev");

    const provider = fakeTeam(() => JSON.stringify({ verdict: "approved" }));
    const { ran, runCommand } = fakeGit({ staged: false });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Nothing staged after `add -A` means the work is already in commits:
    // straight to the merge request, not a failed `git commit`.
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
    expect(ran.find((c) => c[0] === "sh")).toBeDefined();
  });

  it("gives up on a review that never approves, keeping the branch", async () => {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    const workflow = getWorkflow("dev");

    const provider = fakeTeam(() => JSON.stringify({ verdict: "changes-requested", feedback: "No." }));
    const { ran, runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("review-stuck");
    expect(state.visitCounts.planner).toBe(4);
    expect(ran.find((c) => c[0] === "sh")).toBeUndefined();
  });

  it("fails as nothing-changed when the implementer deliberately made no change", async () => {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    const workflow = getWorkflow("dev");

    const provider = new FakeModelProvider((req) => {
      switch (req.context?.nodeId) {
        case "planner":
          return JSON.stringify({ plan: "plan", planFile: "docs/superpowers/plans/thing.md" });
        case "implementer":
          return JSON.stringify({ summary: "The task is already done on this branch.", changed: false });
        default:
          return "{}";
      }
    });
    const { ran, runCommand } = fakeGit({ staged: false });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("nothing-changed");
    expect(state.visitCounts.reviewer ?? 0).toBe(0);
    expect(ran.find((c) => c[0] === "git" && c[1] === "diff")).toBeUndefined();
  });
});
