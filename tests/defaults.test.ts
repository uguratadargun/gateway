import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  it("is a planner, an implementer, a verifier and a reviewer, their super-* twins following skills, and three gates to the person", () => {
    ensureDefaultAgents();
    const byId = new Map(listAgents().agents.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual([
      "acceptance",
      "clarify",
      "implementer",
      "plan-review",
      "planner",
      "quick-implementer",
      "quick-reviewer",
      "reviewer",
      "super-implementer",
      "super-planner",
      "super-reviewer",
      "super-verifier",
      "verifier",
    ]);
    // The dev four follow no skill: their method is in the prompt, and a
    // fresh install runs dev without importing anything. The super four are
    // the same roles bound to superpowers, with the same inputs and outputs,
    // so dev-super can be dev's graph with the agent names swapped.
    for (const id of ["planner", "implementer", "verifier", "reviewer"]) {
      const plain = byId.get(id)!;
      const sup = byId.get(`super-${id}`)!;
      expect(plain.skills).toEqual([]);
      expect(sup.skills.length).toBeGreaterThan(0);
      expect(plain.executor).toBe("claude-code");
      expect(sup.executor).toBe("claude-code");
      expect(sup.inputs).toEqual(plain.inputs);
      expect(sup.output).toEqual(plain.output);
      expect(sup.tools).toEqual(plain.tools);
    }
    // The skill-free planner keeps the rule that matters most: a plan, and
    // nothing else, in a place of its own.
    expect(DEFAULT_AGENTS.planner).toContain("You write a plan, and nothing else.");
    expect(DEFAULT_AGENTS.planner).toContain("docs/plans/");
    expect(DEFAULT_AGENTS.planner).not.toContain("superpowers");
    expect(DEFAULT_AGENTS.implementer).not.toContain("superpowers");
    expect(DEFAULT_AGENTS.reviewer).not.toContain("superpowers");
    expect(DEFAULT_AGENTS.verifier).not.toContain("superpowers");
    // The quick pair follows no skill: it is the point of them. They run as
    // a spawned Claude Code like the rest of the working agents; the
    // implementer edits, the reviewer reads, and both read the base commit
    // or the summary by the node id dev-quick gives those nodes.
    expect(byId.get("quick-implementer")!.skills).toEqual([]);
    expect(byId.get("quick-reviewer")!.skills).toEqual([]);
    expect(byId.get("quick-implementer")!.executor).toBe("claude-code");
    expect(byId.get("quick-reviewer")!.executor).toBe("claude-code");
    expect(byId.get("quick-implementer")!.tools).toContain("edit_file");
    expect(byId.get("quick-reviewer")!.tools).not.toContain("edit_file");
    expect(byId.get("quick-reviewer")!.tools).not.toContain("write_file");
    expect(byId.get("quick-implementer")!.inputs).toContain("reviewer.feedback?");
    expect(byId.get("quick-implementer")!.inputs).toContain("acceptance.requests?");
    expect(byId.get("quick-reviewer")!.inputs).toContain("base.stdout");
    expect(byId.get("quick-reviewer")!.inputs).toContain("implementer.summary");
    expect(byId.get("quick-implementer")!.timeoutMs).toBeLessThan(byId.get("implementer")!.timeoutMs!);
    // The gates follow no skill and decide nothing; they ask, and read. They
    // run on the loop driving the run — the session — never as a spawned
    // Claude Code, which could not ask anyone.
    for (const id of ["clarify", "plan-review", "acceptance"]) {
      expect(byId.get(id)!.skills).toEqual([]);
      expect(byId.get(id)!.tools).not.toContain("write_file");
      expect(byId.get(id)!.executor).toBe("gate");
    }
    // The person's answers, plan feedback and requests all reach the planner.
    expect(byId.get("planner")!.inputs).toContain("clarify.answers?");
    expect(byId.get("planner")!.inputs).toContain("plan-review.feedback?");
    expect(byId.get("planner")!.inputs).toContain("acceptance.requests?");
    // The planner reads its own notes from the last pass: each pass starts
    // with none of the previous one's context, and only what is an output
    // survives the node boundary.
    expect(byId.get("planner")!.inputs).toContain("planner.notes?");
    const plannerOutput = byId.get("planner")!.output;
    expect(plannerOutput.type === "json" ? Object.keys(plannerOutput.schema) : []).toContain("notes");

    // The skills are the point of the super four: without them these are
    // the dev four, and the processes somebody chose deliberately are gone.
    expect(byId.get("super-planner")!.skills).toEqual([
      "superpowers-brainstorming",
      "superpowers-using-git-worktrees",
      "superpowers-writing-plans",
    ]);
    expect(byId.get("super-implementer")!.skills).toContain("superpowers-test-driven-development");
    expect(byId.get("super-implementer")!.skills).toContain("superpowers-subagent-driven-development");
    expect(byId.get("super-reviewer")!.skills).toEqual(["superpowers-requesting-code-review"]);

    // The planner writes the plan file its skills produce and runs the
    // worktree setup; only the implementer edits code; the reviewer reads.
    expect(byId.get("planner")!.tools).toContain("write_file");
    expect(byId.get("planner")!.tools).not.toContain("edit_file");
    expect(byId.get("implementer")!.tools).toContain("edit_file");
    expect(byId.get("reviewer")!.tools).not.toContain("write_file");
    expect(byId.get("reviewer")!.tools).not.toContain("edit_file");

    // The reviewer is handed the run's base, because its skill reviews a git
    // range and the implementer's skills commit as they go — a reviewer left
    // to run a bare `git diff` would see nothing. Not the diff itself: its
    // skill says the diff belongs in the dispatched reviewer's context, not
    // in the coordinator's. It gets the plan file, to hold the diff against
    // the files each task named, and the verifier's evidence.
    expect(byId.get("reviewer")!.inputs).toContain("base.stdout");
    expect(byId.get("reviewer")!.inputs).not.toContain("diff.stdout");
    expect(byId.get("reviewer")!.inputs).toContain("planner.planFile");
    expect(byId.get("reviewer")!.inputs).toContain("verifier.evidence");
    // The reviewer says where its feedback goes; the verifier's gaps go to the implementer.
    const reviewerOutput = byId.get("reviewer")!.output;
    expect(reviewerOutput.type === "json" ? Object.keys(reviewerOutput.schema) : []).toContain("replan");
    expect(byId.get("implementer")!.inputs).toContain("verifier.gaps?");
    // The verifier runs checks and reads; it never edits.
    expect(byId.get("super-verifier")!.skills).toEqual(["superpowers-verification-before-completion"]);
    expect(byId.get("verifier")!.tools).toContain("run_command");
    expect(byId.get("verifier")!.tools).not.toContain("edit_file");
    expect(byId.get("verifier")!.executor).toBe("claude-code");
    // The implementer takes the plan file, which is what its skills execute.
    expect(byId.get("implementer")!.inputs).toContain("planner.planFile");

    // Every agent carries an explicit timeout, the implementer a longer one.
    expect(byId.get("planner")!.timeoutMs).toBe(3_600_000);
    expect(byId.get("reviewer")!.timeoutMs).toBe(3_600_000);
    expect(byId.get("implementer")!.timeoutMs).toBeGreaterThan(3_600_000);
  });
});

describe.each([
  { workflowId: "dev", prefix: "" },
  { workflowId: "dev-super", prefix: "super-" },
])("the shipped pipeline: $workflowId", ({ workflowId, prefix }) => {
  /**
   * The graph, exercised with stand-ins.
   *
   * The shipped agents run as a spawned Claude Code, which a test cannot
   * spawn, so agents of the same names and output shapes stand in for them.
   * What is under test is the workflow: where a rejection goes, what reaches
   * the commit, and how the task travels into the merge request. dev-super
   * is dev's graph on the super-* agents, so the same tests run over both,
   * with the stand-ins saved under whichever names the pipeline uses.
   */
  const WORKING = new Set(["planner", "implementer", "verifier", "reviewer"]);

  /** The workflow under test, its agents replaced by the stand-ins. */
  function standIn() {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(WORKING.has(id) ? `${prefix}${id}` : id, source);
    return getWorkflow(workflowId);
  }

  const STANDINS: Record<string, string> = {
    planner: `---
name: Planner
inputs: [clarify.answers?, plan-review.feedback?, reviewer.feedback?, acceptance.requests?, implementer.summary?]
output:
  type: json
  schema:
    questions: string
    plan: string
    planFile: string
---
Plan {{input.task}} {{inputs.clarify.answers}} {{inputs.plan-review.feedback}} {{inputs.reviewer.feedback}} {{inputs.acceptance.requests}} {{inputs.implementer.summary}}
`,
    clarify: `---
name: Clarify
inputs: [planner.questions]
output:
  type: json
  schema:
    answers: string
---
Ask {{inputs.planner.questions}}
`,
    "plan-review": `---
name: Plan review
inputs: [planner.plan, planner.planFile]
output:
  type: json
  schema:
    decision: string
    feedback: "string?"
---
Show {{inputs.planner.plan}} at {{inputs.planner.planFile}}
`,
    implementer: `---
name: Implementer
inputs: [planner.plan, planner.planFile, reviewer.feedback?, verifier.gaps?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Do {{inputs.planner.planFile}} {{inputs.reviewer.feedback}} {{inputs.verifier.gaps}}
`,
    verifier: `---
name: Verifier
inputs: [planner.plan, planner.planFile, implementer.summary]
output:
  type: json
  schema:
    verified: boolean
    evidence: string
    gaps: "string?"
---
Verify {{inputs.planner.planFile}} against {{inputs.implementer.summary}}
`,
    reviewer: `---
name: Reviewer
inputs: [base.stdout, planner.plan, planner.planFile, implementer.summary, verifier.evidence]
output:
  type: json
  schema:
    verdict: string
    replan: boolean
    feedback: "string?"
---
Review {{inputs.planner.planFile}} from {{inputs.base.stdout}} given {{inputs.verifier.evidence}}
`,
    acceptance: `---
name: Acceptance
inputs: [implementer.summary]
output:
  type: json
  schema:
    decision: string
    requests: "string?"
---
Try {{inputs.implementer.summary}}
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

  const SHIP = () => JSON.stringify({ decision: "ship" });
  const VERIFIED = () => JSON.stringify({ verified: true, evidence: "npm test: 12 passed, 0 failed" });
  const APPROVED = () => JSON.stringify({ verdict: "approved", replan: false });
  const APPROVE = () => JSON.stringify({ decision: "approve" });
  const PLAN = (visit: number) => JSON.stringify({ questions: "", plan: `plan ${visit}`, planFile: "docs/plans/2026-09-08-thing.md" });

  function fakeTeam(
    reviews: (visit: number) => string,
    accepts: (visit: number) => string = SHIP,
    plans: (visit: number) => string = PLAN,
    planReviews: (visit: number) => string = APPROVE,
    clarifies: (visit: number) => string = () => JSON.stringify({ answers: "A: the blue one." }),
    verifies: (visit: number) => string = VERIFIED,
  ) {
    const visits: Record<string, number> = {};
    return new FakeModelProvider((req) => {
      const node = req.context?.nodeId ?? "";
      const visit = (visits[node] = (visits[node] ?? 0) + 1);
      switch (node) {
        case "planner":
          return plans(visit);
        case "clarify":
          return clarifies(visit);
        case "plan-review":
          return planReviews(visit);
        case "implementer":
          return JSON.stringify({ summary: `pass ${visit}`, changed: true });
        case "verifier":
          return verifies(visit);
        case "reviewer":
          return reviews(visit);
        case "acceptance":
          return accepts(visit);
        default:
          return "{}";
      }
    });
  }

  it("loops back to the planner on a rejected review, then commits and opens the merge request", async () => {
    const workflow = standIn();

    const provider = fakeTeam((visit) =>
      visit === 1
        ? JSON.stringify({ verdict: "changes-requested", replan: true, feedback: "Rename `x` to `count`." })
        : APPROVED(),
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
    // The person approved the plan once; the revision the review asked for
    // went straight to the implementer instead of being shown to them again.
    expect(state.visitCounts["plan-review"]).toBe(1);
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

    const mr = ran.find((c) => c.includes("gate-open-mr"))!;
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
    // The title is the task's first line: git refuses a push option with a
    // newline in it, and a brief is often several paragraphs.
    expect(mr[2]).not.toContain('merge_request.title=$1');
    expect(mr[2]).toContain("sed -n 1p");

    const commit = ran.find((c) => c[0] === "git" && c[1] === "commit")!;
    expect(commit).toContain("Add a thing");
    expect(commit).toContain("pass 2");
    // The merge request is opened only after the person said so, and after
    // the commit: what they try with `git merge` has to be on the branch.
    expect(state.visitCounts.acceptance).toBe(1);
    expect(ran.findIndex((c) => c[0] === "git" && c[1] === "commit")).toBeLessThan(ran.findIndex((c) => c.includes("gate-open-mr")));
  });

  it("still carries a revision's questions to the person, and then builds without showing the plan again", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      (visit) => (visit === 1 ? JSON.stringify({ verdict: "changes-requested", replan: true, feedback: "Wrong seam." }) : APPROVED()),
      SHIP,
      (visit) => (visit === 2 ? JSON.stringify({ questions: "Q: keep the old API?", plan: "", planFile: "" }) : PLAN(visit)),
    );
    const { runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Plan, approve, build, reject; ask, answer, plan again — and build.
    expect(state.visitCounts.planner).toBe(3);
    expect(state.visitCounts.clarify).toBe(1);
    expect(state.visitCounts["plan-review"]).toBe(1);
    expect(state.visitCounts.implementer).toBe(2);
    expect(provider.callsFor("clarify")[0].messages[0].content).toContain("keep the old API?");
  });

  it("sends the person's requests back to the planner, and ships once they say so", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      APPROVED,
      (visit) =>
        visit === 1
          ? JSON.stringify({ decision: "revise", requests: "Make the button blue, not green." })
          : JSON.stringify({ decision: "ship" }),
    );
    const { ran, runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Tried once, sent back once, tried again, shipped — through the planner,
    // not the implementer: a person's request is a change of brief.
    expect(state.visitCounts.acceptance).toBe(2);
    expect(state.visitCounts.planner).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    // Their requests are the brief now; the plan they already approved is
    // revised and built, not put in front of them a second time.
    expect(state.visitCounts["plan-review"]).toBe(1);
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[0]).not.toContain("blue");
    expect(plans[1]).toContain("Make the button blue, not green.");
    // One merge request, at the end.
    expect(ran.filter((c) => c.includes("gate-open-mr"))).toHaveLength(1);
  });

  it("holds when nobody is there to approve, leaving the branch committed and unpushed", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      APPROVED,
      () => JSON.stringify({ decision: "hold" }),
    );
    const { ran, runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("completed");
    expect(terminalOf(events)).toBe("awaiting-approval");
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeDefined();
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("skips the commit when the implementer's skills already committed everything", async () => {
    const workflow = standIn();

    const provider = fakeTeam(APPROVED);
    const { ran, runCommand } = fakeGit({ staged: false });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Nothing staged after `add -A` means the work is already in commits:
    // straight to the merge request, not a failed `git commit`.
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeDefined();
  });

  it("sends a bounded fix straight to the implementer, and a plan fault to the planner", async () => {
    const workflow = standIn();

    const provider = fakeTeam((visit) =>
      visit === 1
        ? JSON.stringify({ verdict: "changes-requested", replan: false, feedback: "Call `checkOnlineUsers()` after `setPresenceWatchList`." })
        : APPROVED(),
    );
    const { runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.status).toBe("completed");
    // The planner ran once: a bounded fix does not cost a plan revision, and
    // the plan is not shown to the person again.
    expect(state.visitCounts.planner).toBe(1);
    expect(state.visitCounts["plan-review"]).toBe(1);
    expect(state.visitCounts.implementer).toBe(2);
    // The fix is verified and reviewed again before it ships.
    expect(state.visitCounts.verifier).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    const builds = provider.callsFor("implementer").map((c) => c.messages[0].content);
    expect(builds[0]).not.toContain("checkOnlineUsers");
    expect(builds[1]).toContain("checkOnlineUsers");
  });

  it("sends the verifier's gaps back to the implementer, and gives up after three", async () => {
    const workflow = standIn();

    const gaps = () => JSON.stringify({ verified: false, evidence: "npm test: 1 failed", gaps: "tests/a.test.ts fails: expected 2, got 3" });
    const once = fakeTeam(APPROVED, SHIP, PLAN, APPROVE, undefined, (visit) => (visit === 1 ? gaps() : VERIFIED()));
    const { runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider: once, runCommand, input: { task: "Add a thing" } });
    expect(state.status).toBe("completed");
    expect(state.visitCounts.verifier).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    // The reviewer sees only a tree that passed, and reads the evidence.
    expect(state.visitCounts.reviewer).toBe(1);
    expect(once.callsFor("reviewer")[0].messages[0].content).toContain("12 passed");
    expect(once.callsFor("implementer")[1].messages[0].content).toContain("expected 2, got 3");

    const never = fakeTeam(APPROVED, SHIP, PLAN, APPROVE, undefined, gaps);
    const events: WorkflowEvent[] = [];
    const stuck = await runWorkflow(workflow, { provider: never, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });
    expect(stuck.status).toBe("failed");
    expect(terminalOf(events)).toBe("not-verified");
    expect(stuck.visitCounts.verifier).toBe(3);
    expect(stuck.visitCounts.reviewer ?? 0).toBe(0);
  });

  it("gives up on a review that never approves, keeping the branch", async () => {
    const workflow = standIn();

    const provider = fakeTeam(() => JSON.stringify({ verdict: "changes-requested", replan: true, feedback: "No." }));
    const { ran, runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("review-stuck");
    expect(state.visitCounts.reviewer).toBe(4);
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("carries the planner's questions to the person and their answers back, then shows the plan before building", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      APPROVED,
      SHIP,
      (visit) => (visit === 1 ? JSON.stringify({ questions: "Q: which button?", plan: "", planFile: "" }) : PLAN(visit)),
    );
    const { ran, runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Asked once, answered once, planned again with the answer in hand.
    expect(state.visitCounts.clarify).toBe(1);
    expect(state.visitCounts.planner).toBe(2);
    const asks = provider.callsFor("clarify").map((c) => c.messages[0].content);
    expect(asks[0]).toContain("which button?");
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[0]).not.toContain("blue one");
    expect(plans[1]).toContain("A: the blue one.");
    // The plan was shown before anything was built, and once approved, built.
    expect(state.visitCounts["plan-review"]).toBe(1);
    expect(state.visitCounts.implementer).toBe(1);
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeDefined();
  });

  it("revises the plan on the person's feedback, and builds nothing until they approve", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      APPROVED,
      SHIP,
      PLAN,
      (visit) => (visit === 1 ? JSON.stringify({ decision: "revise", feedback: "Split task 2 in two." }) : APPROVE()),
    );
    const { runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.status).toBe("completed");
    expect(state.visitCounts["plan-review"]).toBe(2);
    expect(state.visitCounts.planner).toBe(2);
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[1]).toContain("Split task 2 in two.");
    // The implementer ran once, after the second, approved plan — not after the first.
    expect(state.visitCounts.implementer).toBe(1);
    expect(provider.callsFor("plan-review")[1].messages[0].content).toContain("plan 2");
  });

  it("ends with the plan written and nothing built when nobody is there to approve it", async () => {
    const workflow = standIn();

    const provider = fakeTeam(APPROVED, SHIP, PLAN, () => JSON.stringify({ decision: "hold" }));
    const { ran, runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("completed");
    expect(terminalOf(events)).toBe("awaiting-plan-approval");
    expect(state.visitCounts.implementer ?? 0).toBe(0);
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
  });

  it("fails as nothing-changed when the implementer deliberately made no change", async () => {
    const workflow = standIn();

    const provider = new FakeModelProvider((req) => {
      switch (req.context?.nodeId) {
        case "planner":
          return JSON.stringify({ questions: "", plan: "plan", planFile: "docs/plans/thing.md" });
        case "plan-review":
          return JSON.stringify({ decision: "approve" });
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

describe("the shipped super pipeline", () => {
  it("is dev's graph on the super-* agents, and nothing else differs", () => {
    ensureDefaultWorkflows();
    const dev = getWorkflow("dev");
    const sup = getWorkflow("dev-super");
    const agentsOf = (w: typeof dev) => w.nodes.filter((n) => n.type === "agent").map((n) => [n.id, (n as { agent: string }).agent]);
    expect(agentsOf(sup)).toEqual([
      ["planner", "super-planner"],
      ["clarify", "clarify"],
      ["plan-review", "plan-review"],
      ["implementer", "super-implementer"],
      ["verifier", "super-verifier"],
      ["reviewer", "super-reviewer"],
      ["acceptance", "acceptance"],
    ]);
    // Everything but the agent names is byte-for-byte dev's: same nodes,
    // same edges, same commands, same terminals.
    const shape = (w: typeof dev) =>
      w.nodes.map((n) => {
        const { agent: _agent, ...rest } = n as { agent?: string } & Record<string, unknown>;
        return rest;
      });
    expect(shape(sup)).toEqual(shape(dev));
    expect(sup.entry).toBe(dev.entry);
    // The only shipped pipeline that needs a skill imported.
    const source = DEFAULT_WORKFLOWS["dev-super"];
    expect(source).toContain("agent: super-planner");
    expect(DEFAULT_WORKFLOWS.dev).not.toContain("super-");
    expect(DEFAULT_WORKFLOWS["dev-quick"]).not.toContain("super-");
  });
});

describe("the shipped quick pipeline", () => {
  /**
   * The short road, with stand-ins of the same names and output shapes as
   * the quick agents. Under test is the graph: that no planner and no gate
   * to the person stand before the change, where a rejection and the
   * person's requests go, and that the ending is dev's.
   */
  const STANDINS: Record<string, string> = {
    "quick-implementer": `---
name: Quick implementer
inputs: [reviewer.feedback?, acceptance.requests?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Change {{input.task}} {{inputs.reviewer.feedback}} {{inputs.acceptance.requests}}
`,
    "quick-reviewer": `---
name: Quick reviewer
inputs: [base.stdout, implementer.summary]
output:
  type: json
  schema:
    verdict: string
    feedback: "string?"
---
Review from {{inputs.base.stdout}} given {{inputs.implementer.summary}}
`,
    acceptance: `---
name: Acceptance
inputs: [implementer.summary]
output:
  type: json
  schema:
    decision: string
    requests: "string?"
---
Try {{inputs.implementer.summary}}
`,
  };

  const BASE = "fedcba9876543210fedcba9876543210fedcba98";

  function terminalOf(events: WorkflowEvent[]): string | undefined {
    const done = events.find((e) => e.type === "workflow.completed");
    return done && "terminalNodeId" in done ? done.terminalNodeId : undefined;
  }

  function fakeGit(opts: { changed?: boolean } = {}) {
    const ran: string[][] = [];
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      switch (node.id) {
        case "base":
          return { ok: true, exitCode: 0, stdout: BASE, stderr: "" };
        case "diff":
          return { ok: true, exitCode: 0, stdout: opts.changed === false ? "" : "--- a.tsx\n+++ a.tsx\n", stderr: "" };
        case "staged":
          // The quick implementer leaves its change uncommitted, so there is
          // always something to commit.
          return { ok: false, exitCode: 1, stdout: "", stderr: "" };
        default:
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
    };
    return { ran, runCommand: runCommand as never };
  }

  const APPROVED = () => JSON.stringify({ verdict: "approved" });
  const SHIP = () => JSON.stringify({ decision: "ship" });

  function fakeTeam(
    reviews: (visit: number) => string = APPROVED,
    accepts: (visit: number) => string = SHIP,
    changes: (visit: number) => string = (visit) => JSON.stringify({ summary: `pass ${visit}`, changed: true }),
  ) {
    const visits: Record<string, number> = {};
    return new FakeModelProvider((req) => {
      const node = req.context?.nodeId ?? "";
      const visit = (visits[node] = (visits[node] ?? 0) + 1);
      switch (node) {
        case "implementer":
          return changes(visit);
        case "reviewer":
          return reviews(visit);
        case "acceptance":
          return accepts(visit);
        default:
          return "{}";
      }
    });
  }

  function quick() {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    return getWorkflow("dev-quick");
  }

  it("changes, reviews, commits, asks and opens the merge request, with no planner in the way", async () => {
    const workflow = quick();
    const provider = fakeTeam();
    const { ran, runCommand } = fakeGit();

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Make the save button blue" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Straight from the base to the change: nothing planned, nothing shown,
    // nothing asked before the implementer runs.
    expect(state.visitCounts.planner ?? 0).toBe(0);
    expect(state.visitCounts["plan-review"] ?? 0).toBe(0);
    expect(state.visitCounts.clarify ?? 0).toBe(0);
    expect(state.visitCounts.verifier ?? 0).toBe(0);
    expect(state.visitCounts.implementer).toBe(1);
    expect(state.visitCounts.reviewer).toBe(1);
    expect(state.visitCounts.acceptance).toBe(1);
    // The quick agents stand in the nodes the shipped acceptance reads from.
    expect(workflow.nodes.find((n) => n.id === "implementer")).toMatchObject({ agent: "quick-implementer" });
    expect(workflow.nodes.find((n) => n.id === "reviewer")).toMatchObject({ agent: "quick-reviewer" });
    expect(workflow.nodes.find((n) => n.id === "acceptance")).toMatchObject({ agent: "acceptance" });

    // The reviewer reads the diff itself, from the base it was handed.
    expect(provider.callsFor("reviewer")[0].messages[0].content).toContain(BASE);
    expect(ran.find((c) => c[0] === "git" && c[1] === "diff" && c.length === 3)).toEqual(["git", "diff", BASE]);
    // The ending is dev's: the task and the summary on the commit, the task
    // as an argument to the merge request, the commit before the push.
    const commit = ran.find((c) => c[0] === "git" && c[1] === "commit")!;
    expect(commit).toContain("Make the save button blue");
    expect(commit).toContain("pass 1");
    const mr = ran.find((c) => c.includes("gate-open-mr"))!;
    expect(mr.at(-1)).toBe("Make the save button blue");
    expect(mr[2]).toContain("glab auth status");
    expect(ran.indexOf(commit)).toBeLessThan(ran.indexOf(mr));
  });

  it("sends a rejected review straight back to the implementer, and gives up after three", async () => {
    const workflow = quick();
    const once = fakeTeam((visit) =>
      visit === 1 ? JSON.stringify({ verdict: "changes-requested", feedback: "Use the theme's `primary` token, not a hex." }) : APPROVED(),
    );
    const { runCommand } = fakeGit();

    const state = await runWorkflow(workflow, { provider: once, runCommand, input: { task: "Make the save button blue" } });
    expect(state.status).toBe("completed");
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    const builds = once.callsFor("implementer").map((c) => c.messages[0].content);
    expect(builds[0]).not.toContain("primary");
    expect(builds[1]).toContain("Use the theme's `primary` token, not a hex.");

    const never = fakeTeam(() => JSON.stringify({ verdict: "changes-requested", feedback: "No." }));
    const events: WorkflowEvent[] = [];
    const { ran, runCommand: git } = fakeGit();
    const stuck = await runWorkflow(workflow, { provider: never, runCommand: git, input: { task: "Make the save button blue" }, emit: (e) => events.push(e) });
    expect(stuck.status).toBe("failed");
    expect(terminalOf(events)).toBe("review-stuck");
    // Three, not dev's four: a small change sent back twice is not converging.
    expect(stuck.visitCounts.reviewer).toBe(3);
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
  });

  it("sends the person's requests back to the implementer, and ships once they say so", async () => {
    const workflow = quick();
    const provider = fakeTeam(APPROVED, (visit) =>
      visit === 1 ? JSON.stringify({ decision: "revise", requests: "Lighter blue, and the hover state too." }) : SHIP(),
    );
    const { ran, runCommand } = fakeGit();

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Make the save button blue" } });

    expect(state.status).toBe("completed");
    expect(state.visitCounts.acceptance).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    const builds = provider.callsFor("implementer").map((c) => c.messages[0].content);
    expect(builds[0]).not.toContain("hover");
    expect(builds[1]).toContain("Lighter blue, and the hover state too.");
    expect(ran.filter((c) => c.includes("gate-open-mr"))).toHaveLength(1);
  });

  it("holds when nobody is there to approve, leaving the branch committed and unpushed", async () => {
    const workflow = quick();
    const provider = fakeTeam(APPROVED, () => JSON.stringify({ decision: "hold" }));
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Make the save button blue" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("completed");
    expect(terminalOf(events)).toBe("awaiting-approval");
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeDefined();
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("ends as nothing-changed when the implementer says the task is not small", async () => {
    const workflow = quick();
    const provider = fakeTeam(APPROVED, SHIP, () =>
      JSON.stringify({ summary: "This needs a new settings page and a migration; not a quick change.", changed: false }),
    );
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add per-user themes" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("nothing-changed");
    expect(state.visitCounts.reviewer ?? 0).toBe(0);
    expect(ran.find((c) => c[0] === "git" && c[1] === "diff")).toBeUndefined();
  });
});

describe("refreshing shipped definitions an update left behind", () => {
  it("rewrites what differs, keeps the model set on it, and puts the old text aside", async () => {
    const { refreshDefaultAgents, staleDefaultAgents, withTuning } = await import("@/agents/defaults");
    const { refreshDefaultWorkflows, staleDefaultWorkflows } = await import("@/workflows/defaults");
    const home = process.env.GATE_HOME;
    process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-refresh-"));
    try {
      ensureDefaultWorkflows();
      const scope = teamScope();
      expect(staleDefaultAgents(scope)).toEqual([]);
      expect(staleDefaultWorkflows(scope)).toEqual([]);

      // An older gate's implementer, tuned to a provider model by the person.
      const file = join(scope.root, "agents", "implementer.md");
      const old = readFileSync(file, "utf8")
        .replace(/^model: .*$/m, "model: provider:zai/glm-5.3-flash")
        .replace("planner.planFile", "planner.steps");
      writeFileSync(file, old);
      const wf = join(scope.root, "workflows", "dev.yaml");
      writeFileSync(wf, `${readFileSync(wf, "utf8")}\n# edited\n`);
      expect(staleDefaultAgents(scope)).toEqual(["implementer"]);
      expect(staleDefaultWorkflows(scope)).toEqual(["dev"]);
      // A tuned model alone is not staleness.
      expect(withTuning(old, DEFAULT_AGENTS.implementer)).toContain("model: provider:zai/glm-5.3-flash");

      expect(refreshDefaultAgents(scope, "T1")).toEqual(["implementer"]);
      expect(refreshDefaultWorkflows(scope, "T1")).toEqual(["dev"]);
      const now = readFileSync(file, "utf8");
      expect(now).toContain("model: provider:zai/glm-5.3-flash");
      expect(now).toContain("planner.planFile");
      expect(now).not.toContain("planner.steps");
      expect(readFileSync(wf, "utf8")).toBe(DEFAULT_WORKFLOWS.dev);
      expect(readFileSync(join(scope.root, "backups", "T1", "agents", "implementer.md"), "utf8")).toBe(old);
      expect(existsSync(join(scope.root, "backups", "T1", "workflows", "dev.yaml"))).toBe(true);
      // Refreshed is no longer stale; a team that only inherits has nothing of its own to refresh.
      expect(staleDefaultAgents(scope)).toEqual([]);
      expect(refreshDefaultAgents(teamScope("ulak"), "T2")).toEqual([]);
    } finally {
      process.env.GATE_HOME = home;
    }
  });
});
