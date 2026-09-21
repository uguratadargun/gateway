import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, ensureDefaultAgents, writeMissingDefaultAgents } from "@/agents/defaults";
import { parseAgent } from "@/agents/loader";
import { agentExists, agentsDir, deleteAgent, getAgent, listAgents, saveAgent } from "@/agents/registry";
import { teamScope } from "@/lib/def-root";
import { runWorkflow } from "@/runtime/engine";
import type { WorkflowEvent } from "@/events/types";
import { DEFAULT_WORKFLOWS, ensureDefaultWorkflows, writeMissingDefaultWorkflows } from "@/workflows/defaults";
import { deleteWorkflow, getWorkflow, listWorkflows, workflowsDir } from "@/workflows/registry";

import { FakeModelProvider } from "./fakes/fake-model-provider";

/** What the recall node answers when memory holds nothing: the shipped agent's honest shape. */
const RECALLED = JSON.stringify({ brief: "Nothing found — memory holds nothing about this.", sources: [], objections: [] });

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
  it("is a planner, an implementer, a verifier and a reviewer, their super-* twins following skills, and four gates to the person", () => {
    ensureDefaultAgents();
    const byId = new Map(listAgents().agents.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual([
      "acceptance",
      "clarify",
      "conflict-review",
      "decide",
      "implementer",
      "investigator",
      "plan-review",
      "planner",
      "quick-implementer",
      "quick-reviewer",
      "recall",
      "record-fix",
      "reviewer",
      "source-review",
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
    // The record fix has no super-* twin on purpose. The superpowers pipeline
    // differs in how it reviews and implements, not in how a paragraph is
    // rewritten, and a second copy of this prompt is a second copy to keep
    // true: shipped agents are named, never copied. dev-super reaches this
    // one by name, which is why the derivation leaves it alone.
    expect(byId.has("super-record-fix")).toBe(false);
    const recordFix = byId.get("record-fix")!;
    // Cheap and bounded, because the judgement was made upstream: the
    // reviewer already said which sentence is wrong and why.
    expect(recordFix.model).toBe("sonnet");
    expect(recordFix.timeoutMs).toBe(900_000);
    expect(recordFix.executor).toBe("claude-code");
    expect(recordFix.output).toEqual({ type: "json", schema: { summary: "string" } });
    // It is told what it may write, and the list is the record and nothing
    // else — a finding it cannot meet without source goes back, not applied.
    expect(DEFAULT_AGENTS["record-fix"]).toContain("CHANGELOG.md");
    expect(DEFAULT_AGENTS["record-fix"]).toContain("You may not change a line of source");
    // And both reviewers say when to take that edge at all.
    for (const id of ["reviewer", "super-reviewer"]) {
      const out = byId.get(id)!.output;
      expect(out.type).toBe("json");
      if (out.type === "json") expect(out.schema).toMatchObject({ recordOnly: "boolean" });
      expect(byId.get(id)!.inputs).toContain("record-fix.summary?");
      expect(DEFAULT_AGENTS[id]).toContain("every** finding you are sending it back for is a\nRecord finding");
    }
    // The skill-free planner keeps the rule that matters most: a plan, and
    // nothing else, in a place of its own.
    expect(DEFAULT_AGENTS.planner).toContain("You write a plan, and nothing else.");
    expect(DEFAULT_AGENTS.planner).toContain("docs/plans/");
    // The repository's record travels with the run: the planner names the
    // documents, the implementer writes them and the spec, the reviewer and
    // verifier hold the change against them, and the quick pair keeps the
    // design doc true without ever writing a decision record.
    expect(DEFAULT_AGENTS.planner).toContain("## Documentation");
    expect(DEFAULT_AGENTS["super-planner"]).toContain("## Documentation");
    expect(DEFAULT_AGENTS.implementer).toContain("docs/specs/");
    expect(DEFAULT_AGENTS["super-implementer"]).toContain("docs/specs/");
    expect(DEFAULT_AGENTS.reviewer).toContain("docs/design/");
    expect(DEFAULT_AGENTS["super-reviewer"]).toContain("docs/design/");
    expect(DEFAULT_AGENTS.verifier).toContain("## Documentation");
    expect(DEFAULT_AGENTS["quick-implementer"]).toContain("docs/design/");
    expect(DEFAULT_AGENTS["quick-implementer"]).toContain("docs/specs/");
    expect(DEFAULT_AGENTS["quick-implementer"]).not.toContain("docs/decisions/");
    expect(DEFAULT_AGENTS["quick-reviewer"]).toContain("docs/design/");
    // The spec check is a command node, and the implementers read what it
    // printed when it sends them back.
    for (const id of ["implementer", "super-implementer", "quick-implementer"]) {
      expect(parseAgent(id, DEFAULT_AGENTS[id], { sourcePath: id, updatedAt: 0 }).inputs).toContain("record.stdout?");
    }
    expect(DEFAULT_AGENTS.recall).toContain("docs/decisions/");
    expect(DEFAULT_AGENTS.investigator).toContain("docs/decisions/");
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
    // The autonomous road's answerer is the gates' opposite: it rules instead
    // of asking, so it carries no `asks` and never pauses a run, reads the
    // planner's questions and notes, and answers under the shape the planner
    // reads from the clarify node.
    const decide = byId.get("decide")!;
    expect(decide.executor).toBe("gate");
    expect(decide.asks).toBeUndefined();
    expect(decide.skills).toEqual([]);
    expect(decide.inputs).toContain("planner.questions");
    expect(decide.inputs).toContain("planner.notes?");
    expect(decide.inputs).toContain("recall.brief?");
    for (const tool of ["write_file", "edit_file", "run_command"]) expect(decide.tools).not.toContain(tool);
    expect(decide.output).toEqual(byId.get("clarify")!.output);
    expect(DEFAULT_AGENTS.decide).toContain("record each one in the plan's Assumptions");
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
    // The acceptance node says where the person's request goes the same way,
    // and a bounded one reaches the implementer directly.
    const acceptanceOutput = byId.get("acceptance")!.output;
    expect(acceptanceOutput.type === "json" ? Object.keys(acceptanceOutput.schema) : []).toContain("replan");
    expect(byId.get("implementer")!.inputs).toContain("acceptance.requests?");
    // The verifier runs checks and reads; it never edits.
    expect(byId.get("super-verifier")!.skills).toEqual(["superpowers-verification-before-completion"]);
    expect(byId.get("verifier")!.tools).toContain("run_command");
    expect(byId.get("verifier")!.tools).not.toContain("edit_file");
    expect(byId.get("verifier")!.executor).toBe("claude-code");
    // The implementer takes the plan file, which is what its skills execute.
    expect(byId.get("implementer")!.inputs).toContain("planner.planFile");

    // The recall node reads memory and nothing else: it runs on gate's own
    // loop (in a session, the session does it with `gate memory`), holds the
    // two memory tools and no write, and every planner reads its brief.
    const recall = byId.get("recall")!;
    expect(recall.executor).toBe("gate");
    expect(recall.skills).toEqual([]);
    expect(recall.tools).toContain("memory_search");
    expect(recall.tools).toContain("memory_feature");
    expect(recall.tools).not.toContain("write_file");
    expect(recall.tools).not.toContain("edit_file");
    expect(recall.output.type === "json" ? Object.keys(recall.output.schema) : []).toEqual(["brief", "sources", "objections"]);
    for (const id of ["planner", "super-planner", "quick-implementer"]) {
      expect(byId.get(id)!.inputs).toContain("recall.brief?");
      expect(DEFAULT_AGENTS[id]).toContain("{{inputs.recall.brief}}");
    }

    // The investigator reads history and may try a fix in the worktree; it
    // runs in its own model, reads the recall brief, and labels its certainty.
    const investigator = byId.get("investigator")!;
    expect(investigator.executor).toBe("claude-code");
    expect(investigator.inputs).toContain("recall.brief?");
    expect(investigator.inputs).toContain("base.stdout");
    expect(investigator.output.type === "json" ? Object.keys(investigator.output.schema) : []).toEqual(
      expect.arrayContaining(["certainty", "related", "suspected", "confirmed", "fix", "verified", "report"]),
    );
    expect(DEFAULT_AGENTS.investigator).toContain("No commit, no push.");

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
    conflictKey: string
    plan: string
    planFile: string
    conflicts: "object[]?"
---
Plan {{input.task}} {{inputs.clarify.answers}} {{inputs.plan-review.feedback}} {{inputs.reviewer.feedback}} {{inputs.acceptance.requests}} {{inputs.implementer.summary}}
`,
    "conflict-review": `---
name: Cross-team objection
inputs: [planner.conflicts, planner.conflictKey, visits.planner]
output:
  type: json
  schema:
    decision: string
    resolved: "object[]"
    note: "string?"
---
Ask about {{inputs.planner.conflictKey}} raised on visit {{inputs.visits.planner}}
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
inputs: [planner.plan, planner.planFile, reviewer.feedback?, verifier.gaps?, acceptance.requests?, record.stdout?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Do {{inputs.planner.planFile}} {{inputs.reviewer.feedback}} {{inputs.verifier.gaps}} {{inputs.acceptance.requests}} {{inputs.record.stdout}}
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
    // Kept at the shape the reviewer had before recordOnly existed, so that
    // every test below this one is also a test that a team whose reviewer
    // has not been refreshed keeps the pipeline it had: an absent key
    // compared against true is false, and the record edges fall through.
    // The tests that exercise the record round save a newer one over it.
    "record-fix": `---
name: Record fix
inputs: [base.stdout, planner.planFile, implementer.summary, reviewer.feedback?]
output:
  type: json
  schema:
    summary: string
---
Fix the record for {{inputs.planner.planFile}} from {{inputs.base.stdout}}: {{inputs.reviewer.feedback}} {{inputs.implementer.summary}}
`,
    acceptance: `---
name: Acceptance
inputs: [implementer.summary]
output:
  type: json
  schema:
    decision: string
    replan: "boolean?"
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
  function fakeGit(opts: { staged: boolean; changed?: boolean; spec?: (visit: number) => boolean }) {
    const ran: string[][] = [];
    let specChecks = 0;
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      switch (node.id) {
        case "base":
          return { ok: true, exitCode: 0, stdout: BASE, stderr: "" };
        case "record":
          // The spec is there unless the test says otherwise; when it is not,
          // the command prints what to do and fails, as the real one does.
          specChecks += 1;
          return (opts.spec?.(specChecks) ?? true)
            ? { ok: true, exitCode: 0, stdout: "", stderr: "" }
            : { ok: false, exitCode: 1, stdout: "No spec under docs/specs/. Copy the plan file", stderr: "" };
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
  /** The planner finds another team's decision unworkable and stops there. */
  const OBJECT_TO = () =>
    JSON.stringify({
      questions: "",
      conflictKey: "pq-kem",
      plan: "",
      planFile: "",
      conflicts: [
        {
          conflictKey: "pq-kem",
          targetTeamId: "desktop",
          title: "the KEM choice does not fit our handshake",
          decisionSnapshot: "desktop settled on X25519+Kyber768 in the client",
          rationale: "our handshake cannot carry the second key share in the first flight",
          proposal: "move the share to the second flight",
          revision: "revise the client handshake before shipping",
          paths: ["src/crypto"],
        },
      ],
    });

  const CONFIRM_OBJECTION = () =>
    JSON.stringify({ decision: "confirm", resolved: [{ sourceNodeId: "planner", sourceVisit: 1, conflictKey: "pq-kem", decision: "confirm", note: "yes, they have to revise" }] });

  const REJECT_OBJECTION = () =>
    JSON.stringify({ decision: "reject", resolved: [{ sourceNodeId: "planner", sourceVisit: 1, conflictKey: "pq-kem", decision: "reject", note: "the second flight is fine" }], note: "the second flight is fine" });

  const PLAN = (visit: number) => JSON.stringify({ questions: "", conflictKey: "", plan: `plan ${visit}`, planFile: "docs/plans/2026-09-08-thing.md" });

  function fakeTeam(
    reviews: (visit: number) => string,
    accepts: (visit: number) => string = SHIP,
    plans: (visit: number) => string = PLAN,
    planReviews: (visit: number) => string = APPROVE,
    clarifies: (visit: number) => string = () => JSON.stringify({ answers: "A: the blue one." }),
    verifies: (visit: number) => string = VERIFIED,
    conflictReviews: (visit: number) => string = CONFIRM_OBJECTION,
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
        case "conflict-review":
          return conflictReviews(visit);
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
        case "record-fix":
          return JSON.stringify({ summary: `record pass ${visit}` });
        default:
          return req.context?.nodeId === "recall" ? RECALLED : "{}";
      }
    });
  }

  /**
   * The reviewer as it ships now. Saved over the stand-in by the tests that
   * drive the record round, so that the stand-in itself stays at the older
   * shape and every other test keeps proving the fall-through.
   */
  const REVIEWER_WITH_RECORD_ONLY = `---
name: Reviewer
inputs: [base.stdout, planner.plan, planner.planFile, implementer.summary, verifier.evidence, record-fix.summary?]
output:
  type: json
  schema:
    verdict: string
    replan: boolean
    recordOnly: boolean
    feedback: "string?"
---
Review {{inputs.planner.planFile}} from {{inputs.base.stdout}} given {{inputs.verifier.evidence}} {{inputs.record-fix.summary}}
`;

  const RECORD_ONLY = () => JSON.stringify({ verdict: "changes-requested", replan: false, recordOnly: true, feedback: "docs/design/x.md says the old thing." });

  /**
   * An approval from that reviewer. `recordOnly` is required there, exactly as
   * `replan` is, so an approval carries it too — the prompt says it is false
   * when the verdict is approved, and a reply that leaves it out fails output
   * validation rather than being read as anything. `APPROVED` above stays as
   * it is: it is what an older team's reviewer answers, and the tests that use
   * it are the ones proving that shape still works.
   */
  const APPROVED_WITH_RECORD_ONLY = () => JSON.stringify({ verdict: "approved", replan: false, recordOnly: false });

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
    // The remote's host picks the route, not whichever CLI happens to be
    // installed: GitHub has no push options, so a GitHub remote goes through
    // gh, and a machine whose gh is not signed in says so rather than pushing
    // a branch no pull request will ever point at.
    expect(mr[2]).toContain("git remote get-url origin");
    expect(mr[2]).toContain("*github.com*");
    expect(mr[2]).toContain("gh pr create");
    expect(mr[2]).toContain("gh auth status");
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
      (visit) => (visit === 2 ? JSON.stringify({ questions: "Q: keep the old API?", conflictKey: "", plan: "", planFile: "" }) : PLAN(visit)),
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
          ? JSON.stringify({ decision: "revise", replan: true, requests: "Make the button blue, not green." })
          : JSON.stringify({ decision: "ship", replan: false }),
    );
    const { ran, runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Tried once, sent back once, tried again, shipped — through the planner,
    // because the acceptance node judged the request a change of plan.
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

  it("sends a bounded request from the person straight to the implementer, and a plan change to the planner", async () => {
    const workflow = standIn();
    const provider = fakeTeam(APPROVED, (visit) =>
      visit === 1
        ? JSON.stringify({ decision: "revise", replan: false, requests: "Translate the Turkish commit messages to English." })
        : SHIP(),
    );
    const { runCommand } = fakeGit({ staged: true });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.status).toBe("completed");
    // A wording change is one more task against the plan as it stands: the
    // implementer continues, the verifier and reviewer run again, and the
    // planner is never woken — measured here, a seven-minute plan and a
    // nine-minute build for a change of words when every request went there.
    expect(state.visitCounts.planner).toBe(1);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.verifier).toBe(2);
    expect(state.visitCounts.reviewer).toBe(2);
    expect(state.visitCounts.acceptance).toBe(2);
    const builds = provider.callsFor("implementer").map((c) => c.messages[0].content);
    expect(builds[0]).not.toContain("Turkish");
    expect(builds[1]).toContain("Translate the Turkish commit messages to English.");
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

  it("sends the implementer back for the spec it did not write, and gives up after three", async () => {
    const workflow = standIn();

    // The verifier passed; the spec check did not. The implementer hears what
    // the command printed, writes the spec, and the run goes on to review
    // without verifying again.
    const once = fakeTeam(APPROVED, SHIP, PLAN, APPROVE);
    const { runCommand } = fakeGit({ staged: true, spec: (visit) => visit > 1 });
    const state = await runWorkflow(workflow, { provider: once, runCommand, input: { task: "Add a thing" } });
    expect(state.status).toBe("completed");
    expect(state.visitCounts.record).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.verifier).toBe(2);
    expect(state.visitCounts.reviewer).toBe(1);
    expect(once.callsFor("implementer")[1].messages[0].content).toContain("No spec under docs/specs/");

    const never = fakeTeam(APPROVED, SHIP, PLAN, APPROVE);
    const events: WorkflowEvent[] = [];
    const stuck = await runWorkflow(workflow, {
      provider: never,
      runCommand: fakeGit({ staged: true, spec: () => false }).runCommand,
      input: { task: "Add a thing" },
      emit: (e) => events.push(e),
    });
    expect(stuck.status).toBe("failed");
    expect(terminalOf(events)).toBe("no-spec");
    expect(stuck.visitCounts.record).toBe(3);
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

  /**
   * The lap a documentation finding used to cost.
   *
   * Before this edge, a reviewer that wanted one sentence in a design doc
   * changed sent the whole change back through the implementer and the
   * verifier — fifty minutes measured — and spent one of its four reviews
   * doing it. Three such sentences ended a real run at review-stuck with
   * every code defect already fixed.
   */
  it("sends a record-only rejection to the record fix and back, without rebuilding or re-verifying", async () => {
    const workflow = standIn();
    saveAgent(`${prefix}reviewer`, REVIEWER_WITH_RECORD_ONLY);

    // First review: only the record is wrong. Second: it ships.
    const provider = fakeTeam((visit) => (visit === 1 ? RECORD_ONLY() : APPROVED_WITH_RECORD_ONLY()));
    const { ran, runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(terminalOf(events)).toBe("done");
    expect(state.status).toBe("completed");
    expect(state.visitCounts["record-fix"]).toBe(1);
    expect(state.visitCounts.reviewer).toBe(2);
    // The point of the edge: neither of these ran a second time.
    expect(state.visitCounts[`${prefix}implementer`] ?? state.visitCounts.implementer).toBe(1);
    expect(state.visitCounts[`${prefix}verifier`] ?? state.visitCounts.verifier).toBe(1);
    expect(state.visitCounts.planner).toBe(1);
    // It is given the reviewer's feedback, which is the whole of its brief.
    expect(provider.callsFor("record-fix")[0].messages[0].content).toContain("docs/design/x.md says the old thing");
    // And the second review is told what it wrote.
    expect(provider.callsFor("reviewer")[1].messages[0].content).toContain("record pass 1");
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeDefined();
  });

  it("gives up on a record that is still wrong after two passes, on a terminal of its own", async () => {
    const workflow = standIn();
    saveAgent(`${prefix}reviewer`, REVIEWER_WITH_RECORD_ONLY);

    const provider = fakeTeam(RECORD_ONLY);
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow, {
      provider,
      runCommand: fakeGit({ staged: true }).runCommand,
      input: { task: "Add a thing" },
      emit: (e) => events.push(e),
    });

    expect(state.status).toBe("failed");
    // Not review-stuck: the code was accepted and the writing was not.
    expect(terminalOf(events)).toBe("record-wrong");
    expect(state.visitCounts["record-fix"]).toBe(2);
    expect(state.visitCounts.reviewer).toBe(3);
  });

  /**
   * The give-up arithmetic, and the reason the give-up edge is written three
   * times. A visit is counted when a node runs, before its edges are read, so
   * a record round increments visits.reviewer exactly as a rejection does —
   * declaring the record edges above the give-up edge decides which edge wins
   * but does not stop the counter. Written once as `visits.reviewer >= 4`,
   * two record rounds would leave a change two real rejections, which is
   * worse than not having the record round at all. So the give-up edge means
   * `visits.reviewer - visits.record-fix >= 4`, spelled out per value of
   * record-fix because the condition language has no arithmetic.
   */
  it("does not spend a review on a record round: four rejections still reach review-stuck after two", async () => {
    const workflow = standIn();
    saveAgent(`${prefix}reviewer`, REVIEWER_WITH_RECORD_ONLY);

    // Two record rounds first, then nothing but ordinary rejections.
    const provider = fakeTeam((visit) =>
      visit <= 2 ? RECORD_ONLY() : JSON.stringify({ verdict: "changes-requested", replan: true, recordOnly: false, feedback: "No." }),
    );
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow, {
      provider,
      runCommand: fakeGit({ staged: true }).runCommand,
      input: { task: "Add a thing" },
      emit: (e) => events.push(e),
    });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("review-stuck");
    // Two record rounds plus the four reviews the pipeline has always had.
    expect(state.visitCounts["record-fix"]).toBe(2);
    expect(state.visitCounts.reviewer).toBe(6);
  });

  it("carries the planner's questions to the person and their answers back, then shows the plan before building", async () => {
    const workflow = standIn();

    const provider = fakeTeam(
      APPROVED,
      SHIP,
      (visit) => (visit === 1 ? JSON.stringify({ questions: "Q: which button?", conflictKey: "", plan: "", planFile: "" }) : PLAN(visit)),
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

  // The case the whole cross-team path exists for: the planner reads a
  // decision another team already made, finds this change cannot live with
  // it, and says so instead of planning around it. Nothing is built, and
  // nothing goes to the other team until the person says the objection holds.
  it("stops the run when the person confirms the planner's objection to another team's decision", async () => {
    const workflow = standIn();

    const provider = fakeTeam(APPROVED, SHIP, OBJECT_TO);
    const { runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.error).toBeNull();
    expect(terminalOf(events)).toBe("blocked-by-objection");
    // Not one line of it was built, and the person was never shown a plan:
    // there is no plan to show until the objection is settled.
    expect(state.visitCounts.implementer).toBeUndefined();
    expect(state.visitCounts["plan-review"]).toBeUndefined();
    // The node that asked got the planner's own visit number, which is what
    // joins the person's answer to the objection the planner raised.
    expect(provider.callsFor("conflict-review")[0].messages[0].content).toContain("pq-kem raised on visit 1");
  });

  it("carries on with the plan when the person says the objection does not hold", async () => {
    const workflow = standIn();

    // Objects on the first pass; once told the objection is wrong, plans.
    const provider = fakeTeam(APPROVED, SHIP, (visit) => (visit === 1 ? OBJECT_TO() : PLAN(visit)), APPROVE, undefined, VERIFIED, REJECT_OBJECTION);
    const { runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.error).toBeNull();
    expect(terminalOf(events)).toBe("done");
    // Asked once, answered once: a rejected objection is not put again.
    expect(state.visitCounts["conflict-review"]).toBe(1);
    expect(state.visitCounts.implementer).toBe(1);
  });

  it("holds the objection rather than deciding it when nobody is there to answer", async () => {
    const workflow = standIn();

    const provider = fakeTeam(APPROVED, SHIP, OBJECT_TO, APPROVE, undefined, VERIFIED, () =>
      JSON.stringify({ decision: "hold", resolved: [] }),
    );
    const { runCommand } = fakeGit({ staged: true });
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    // An unanswered objection is neither confirmed nor waved through: the run
    // stops with it on the record, and the other team hears nothing.
    expect(state.status).toBe("completed");
    expect(terminalOf(events)).toBe("awaiting-objection-answer");
    expect(state.visitCounts.implementer ?? 0).toBe(0);
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
          return JSON.stringify({ questions: "", conflictKey: "", plan: "plan", planFile: "docs/plans/thing.md" });
        case "plan-review":
          return JSON.stringify({ decision: "approve" });
        case "implementer":
          return JSON.stringify({ summary: "The task is already done on this branch.", changed: false });
        default:
          return req.context?.nodeId === "recall" ? RECALLED : "{}";
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
      ["recall", "recall"],
      ["planner", "super-planner"],
      ["conflict-review", "conflict-review"],
      ["clarify", "clarify"],
      ["plan-review", "plan-review"],
      ["implementer", "super-implementer"],
      ["verifier", "super-verifier"],
      ["reviewer", "super-reviewer"],
      // Not swapped, and there is no super-record-fix to swap it for: the
      // derivation renames the four working agents, and fixing a paragraph
      // is the same job whichever method built the change.
      ["record-fix", "record-fix"],
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
inputs: [reviewer.feedback?, acceptance.requests?, record.stdout?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Change {{input.task}} {{inputs.reviewer.feedback}} {{inputs.acceptance.requests}} {{inputs.record.stdout}}
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
    replan: "boolean?"
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

  function fakeGit(opts: { changed?: boolean; spec?: (visit: number) => boolean } = {}) {
    const ran: string[][] = [];
    let specChecks = 0;
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      switch (node.id) {
        case "base":
          return { ok: true, exitCode: 0, stdout: BASE, stderr: "" };
        case "record":
          specChecks += 1;
          return (opts.spec?.(specChecks) ?? true)
            ? { ok: true, exitCode: 0, stdout: "", stderr: "" }
            : { ok: false, exitCode: 1, stdout: "No spec under docs/specs/. Write docs/specs/", stderr: "" };
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
          return req.context?.nodeId === "recall" ? RECALLED : "{}";
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

  it("sends the quick implementer back for the spec it did not write", async () => {
    const workflow = quick();
    const provider = fakeTeam();
    const { runCommand } = fakeGit({ spec: (visit) => visit > 1 });

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Make the save button blue" } });
    expect(state.status).toBe("completed");
    expect(state.visitCounts.record).toBe(2);
    expect(state.visitCounts.implementer).toBe(2);
    expect(state.visitCounts.reviewer).toBe(1);
    expect(provider.callsFor("implementer")[1].messages[0].content).toContain("No spec under docs/specs/");
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

describe("the shipped autonomous pipeline", () => {
  /**
   * dev with nobody in the loop. Under test is the graph: that no node on it
   * asks anyone, that the planner's questions are answered by the run and
   * reach the planner under the name it reads, where the answering gives up,
   * that an objection stops the run, and that the reviewer's approval is
   * what opens the merge request.
   */
  const STANDINS: Record<string, string> = {
    planner: `---
name: Planner
inputs: [clarify.answers?, reviewer.feedback?, implementer.summary?]
output:
  type: json
  schema:
    questions: string
    conflictKey: string
    plan: string
    planFile: string
    notes: string
    conflicts: "object[]?"
---
Plan {{input.task}} {{inputs.clarify.answers}} {{inputs.reviewer.feedback}} {{inputs.implementer.summary}}
`,
    decide: `---
name: Decide
inputs: [planner.questions, planner.notes?]
output:
  type: json
  schema:
    answers: string
---
Rule on {{inputs.planner.questions}} given {{inputs.planner.notes}}
`,
    implementer: `---
name: Implementer
inputs: [planner.plan, planner.planFile, reviewer.feedback?, verifier.gaps?, record.stdout?]
output:
  type: json
  schema:
    summary: string
    changed: boolean
---
Do {{inputs.planner.planFile}} {{inputs.reviewer.feedback}} {{inputs.verifier.gaps}} {{inputs.record.stdout}}
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
    "record-fix": `---
name: Record fix
inputs: [base.stdout, planner.planFile, implementer.summary, reviewer.feedback?]
output:
  type: json
  schema:
    summary: string
---
Fix the record for {{inputs.planner.planFile}} from {{inputs.base.stdout}}: {{inputs.reviewer.feedback}} {{inputs.implementer.summary}}
`,
  };

  const BASE = "abcdef0123456789abcdef0123456789abcdef01";

  function terminalOf(events: WorkflowEvent[]): string | undefined {
    const done = events.find((e) => e.type === "workflow.completed");
    return done && "terminalNodeId" in done ? done.terminalNodeId : undefined;
  }

  function fakeGit(opts: { staged?: boolean; changed?: boolean } = {}) {
    const ran: string[][] = [];
    const runCommand = async (node: { id: string; command: string[] }) => {
      ran.push(node.command);
      switch (node.id) {
        case "base":
          return { ok: true, exitCode: 0, stdout: BASE, stderr: "" };
        case "diff":
          return { ok: true, exitCode: 0, stdout: opts.changed === false ? "" : "--- a.ts\n+++ a.ts\n", stderr: "" };
        case "staged":
          return opts.staged === false ? { ok: true, exitCode: 0, stdout: "", stderr: "" } : { ok: false, exitCode: 1, stdout: "", stderr: "" };
        default:
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
    };
    return { ran, runCommand: runCommand as never };
  }

  const PLAN = (visit: number) =>
    JSON.stringify({ questions: "", conflictKey: "", plan: `plan ${visit}`, planFile: "docs/plans/2026-09-20-thing.md", notes: `notes ${visit}` });
  const ASK = (visit: number) =>
    JSON.stringify({ questions: "Which surface: the settings page, or a flag? (recommend: the flag)", conflictKey: "", plan: "", planFile: "", notes: `notes ${visit}` });
  const VERIFIED = () => JSON.stringify({ verified: true, evidence: "npm test: 12 passed, 0 failed" });
  const APPROVED = () => JSON.stringify({ verdict: "approved", replan: false });
  const RULED = () => JSON.stringify({ answers: "Which surface — the flag; the settings page is a new surface the task did not ask for.\nThese were decided by the run, not by the person: record each one in the plan's Assumptions." });

  function fakeTeam(
    reviews: (visit: number) => string = APPROVED,
    plans: (visit: number) => string = PLAN,
    decides: (visit: number) => string = RULED,
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
          return decides(visit);
        case "implementer":
          return JSON.stringify({ summary: `pass ${visit}`, changed: true });
        case "verifier":
          return verifies(visit);
        case "reviewer":
          return reviews(visit);
        case "record-fix":
          return JSON.stringify({ summary: `record pass ${visit}` });
        default:
          return node === "recall" ? RECALLED : "{}";
      }
    });
  }

  function auto() {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    return getWorkflow("dev-auto");
  }

  it("has no node that asks anyone, and no ceiling the engine enforces", () => {
    const workflow = auto();
    const agents = workflow.nodes.filter((n) => n.type === "agent").map((n) => (n as { agent: string }).agent);
    for (const gate of ["clarify", "plan-review", "acceptance", "conflict-review"]) expect(agents).not.toContain(gate);
    for (const id of agents) expect(getAgent(id).asks).toBeUndefined();
    // The same working four as dev, no skill among them, and the answerer in
    // the clarify node's place — under that id, which is what the planner reads.
    expect(agents).toEqual(["recall", "planner", "decide", "implementer", "verifier", "reviewer", "record-fix"]);
    expect(workflow.nodes.find((n) => n.id === "clarify")).toMatchObject({ agent: "decide" });
    expect(DEFAULT_WORKFLOWS["dev-auto"]).not.toContain("super-");
    expect(workflow.maxWorkflowSteps ?? 0).toBe(0);
    expect(workflow.maxVisits ?? 0).toBe(0);
    expect(workflow.maxCostUsd ?? 0).toBe(0);
    // Every loop has its own way out, on a terminal that says what is stuck.
    const terminals = workflow.nodes.filter((n) => n.type === "terminal").map((n) => n.id);
    expect(terminals).toEqual(expect.arrayContaining(["never-planned", "review-stuck", "not-verified", "no-spec", "objection-needs-a-person", "record-wrong"]));
  });

  it("answers the planner's questions itself, builds, verifies, reviews, commits and opens the merge request", async () => {
    const workflow = auto();
    const provider = fakeTeam(APPROVED, (visit) => (visit === 1 ? ASK(visit) : PLAN(visit)));
    const { ran, runCommand } = fakeGit();

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    // Asked once, answered by the run, planned on the second pass; nothing
    // shown, nothing tried, nobody asked.
    expect(state.visitCounts.planner).toBe(2);
    expect(state.visitCounts.clarify).toBe(1);
    expect(state.visitCounts["plan-review"] ?? 0).toBe(0);
    expect(state.visitCounts.acceptance ?? 0).toBe(0);
    expect(state.visitCounts.implementer).toBe(1);
    expect(state.visitCounts.verifier).toBe(1);
    expect(state.visitCounts.reviewer).toBe(1);
    // The questions reach the answerer with the planner's notes, and the
    // answers reach the planner's second pass under the name it reads.
    const ruling = provider.callsFor("clarify")[0].messages[0].content;
    expect(ruling).toContain("Which surface");
    expect(ruling).toContain("notes 1");
    const plans = provider.callsFor("planner").map((c) => c.messages[0].content);
    expect(plans[0]).not.toContain("the flag;");
    expect(plans[1]).toContain("the flag; the settings page is a new surface");
    // The ending is dev's without the person: commit, then the merge request,
    // with the task as the title.
    const commit = ran.find((c) => c[0] === "git" && c[1] === "commit")!;
    expect(commit).toContain("Add a thing");
    expect(commit).toContain("pass 1");
    const mr = ran.find((c) => c.includes("gate-open-mr"))!;
    expect(mr.at(-1)).toBe("Add a thing");
    expect(ran.indexOf(commit)).toBeLessThan(ran.indexOf(mr));
  });

  it("opens the merge request straight from a branch the implementer already committed", async () => {
    const workflow = auto();
    const { ran, runCommand } = fakeGit({ staged: false });
    const state = await runWorkflow(workflow, { provider: fakeTeam(), runCommand, input: { task: "Add a thing" } });
    expect(state.status).toBe("completed");
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeDefined();
  });

  it("gives up when the planner is still asking after three rounds of answers", async () => {
    const workflow = auto();
    const provider = fakeTeam(APPROVED, ASK);
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("never-planned");
    expect(state.visitCounts.clarify).toBe(3);
    expect(state.visitCounts.planner).toBe(4);
    expect(state.visitCounts.implementer ?? 0).toBe(0);
    expect(ran.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
  });

  it("stops when the planner objects to another team's decision, building nothing", async () => {
    const workflow = auto();
    const provider = fakeTeam(APPROVED, () =>
      JSON.stringify({
        questions: "",
        conflictKey: "pq-kem",
        plan: "",
        planFile: "",
        notes: "",
        conflicts: [{ conflictKey: "pq-kem", targetTeamId: "desktop", title: "the KEM choice does not fit our handshake" }],
      }),
    );
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("objection-needs-a-person");
    expect(state.visitCounts.clarify ?? 0).toBe(0);
    expect(state.visitCounts.implementer ?? 0).toBe(0);
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("sends a rejection where the reviewer says, and gives up after four reviews with nothing pushed", async () => {
    const workflow = auto();
    const provider = fakeTeam((visit) =>
      visit === 1
        ? JSON.stringify({ verdict: "changes-requested", replan: true, feedback: "Cut at the wrong seam." })
        : visit === 2
          ? JSON.stringify({ verdict: "changes-requested", replan: false, feedback: "Missing the test for the empty case." })
          : APPROVED(),
    );
    const { ran, runCommand } = fakeGit();

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" } });
    expect(state.status).toBe("completed");
    // A fault in the plan went to the planner, a bounded fix to the implementer.
    expect(state.visitCounts.planner).toBe(2);
    expect(state.visitCounts.implementer).toBe(3);
    expect(state.visitCounts.reviewer).toBe(3);
    expect(provider.callsFor("planner")[1].messages[0].content).toContain("Cut at the wrong seam.");
    expect(provider.callsFor("implementer")[2].messages[0].content).toContain("Missing the test for the empty case.");
    expect(ran.filter((c) => c.includes("gate-open-mr"))).toHaveLength(1);

    const never = fakeTeam(() => JSON.stringify({ verdict: "changes-requested", replan: false, feedback: "No." }));
    const events: WorkflowEvent[] = [];
    const { ran: stuckRan, runCommand: git } = fakeGit();
    const stuck = await runWorkflow(workflow, { provider: never, runCommand: git, input: { task: "Add a thing" }, emit: (e) => events.push(e) });
    expect(stuck.status).toBe("failed");
    expect(terminalOf(events)).toBe("review-stuck");
    expect(stuck.visitCounts.reviewer).toBe(4);
    expect(stuckRan.find((c) => c[0] === "git" && c[1] === "commit")).toBeUndefined();
    expect(stuckRan.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("sends the verifier's gaps back to the implementer, and gives up after three checks", async () => {
    const workflow = auto();
    const provider = fakeTeam(APPROVED, PLAN, RULED, () => JSON.stringify({ verified: false, evidence: "npm test: 1 failed", gaps: "Task 2 not done." }));
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    expect(state.status).toBe("failed");
    expect(terminalOf(events)).toBe("not-verified");
    expect(state.visitCounts.verifier).toBe(3);
    expect(state.visitCounts.implementer).toBe(3);
    expect(state.visitCounts.reviewer ?? 0).toBe(0);
    expect(ran.find((c) => c.includes("gate-open-mr"))).toBeUndefined();
  });

  it("takes the record round, which is the loop it most needs with nobody to ask", async () => {
    const workflow = auto();
    const provider = fakeTeam((visit) =>
      visit === 1
        ? JSON.stringify({ verdict: "changes-requested", replan: false, recordOnly: true, feedback: "docs/design/x.md says the old thing." })
        : APPROVED(),
    );
    const { ran, runCommand } = fakeGit();
    const events: WorkflowEvent[] = [];

    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Add a thing" }, emit: (e) => events.push(e) });

    // The record agent ran, the builders did not run again, and the branch
    // still shipped. On this road that matters more than on dev: nobody is
    // watching, so a run that ends failed over a sentence is read hours later.
    expect(terminalOf(events)).toBe("done");
    expect(state.visitCounts["record-fix"]).toBe(1);
    expect(state.visitCounts.implementer).toBe(1);
    expect(state.visitCounts.verifier).toBe(1);
    expect(state.visitCounts.reviewer).toBe(2);
    expect(ran.filter((c) => c.includes("gate-open-mr"))).toHaveLength(1);
  });

  /**
   * What keeps this graph in step with dev, since it is written out rather
   * than derived. Every node dev has is here with the same shape, bar the
   * ones listed — and a change to dev that is not made here fails on the
   * lists, not on a run months later.
   */
  it("is dev's graph with the person taken out of it, and nothing else differs", () => {
    ensureDefaultWorkflows();
    const dev = getWorkflow("dev");
    const graph = getWorkflow("dev-auto");
    const ids = (w: typeof dev) => w.nodes.map((n) => n.id);

    // The person's three turns, and the terminals that exist only because a
    // node can hold for them.
    expect(ids(dev).filter((id) => !ids(graph).includes(id))).toEqual([
      "conflict-review",
      "conflict-decision",
      "plan-review",
      "plan-decision",
      "acceptance",
      "decision",
      "awaiting-approval",
      "awaiting-plan-approval",
      "blocked-by-objection",
      "awaiting-objection-answer",
    ]);
    // And the two terminals this road adds: a question it will not answer,
    // and a plan it never reached.
    expect(ids(graph).filter((id) => !ids(dev).includes(id))).toEqual(["objection-needs-a-person", "never-planned"]);

    // Every node both have does the same thing: same type, same agent, same
    // command, same terminal status. Only the routing may differ, and only
    // where a node the person stood on was taken out.
    const byId = new Map(dev.nodes.map((n) => [n.id, n]));
    const body = (n: unknown) => {
      const { label: _label, edges: _edges, next: _next, ...rest } = n as Record<string, unknown>;
      return rest;
    };
    const routing = (n: unknown) => {
      const { edges, next } = n as Record<string, unknown>;
      return { edges, next };
    };
    // Named one by one rather than skipped by a flag: each is a node whose
    // edges point at something this road does not have.
    const REROUTED = new Set([
      "clarify", // runs decide, and the agent is part of the body
      "conflict-check", // objects to a terminal, not to the person
      "plan-check", // no plan review to gate on
      "verdict", // the record and give-up edges are dev's; the rest is not
      "staged", // straight to the merge request, with no acceptance between
      "commit", // the same
    ]);
    for (const node of graph.nodes) {
      const twin = byId.get(node.id);
      if (!twin) continue;
      if (node.id !== "clarify") expect(body(node), `node ${node.id} has drifted from dev's`).toEqual(body(twin));
      if (!REROUTED.has(node.id)) expect(routing(node), `node ${node.id} routes differently from dev's`).toEqual(routing(twin));
    }
    // And the rerouting is all of it: nothing else in the graph moved.
    expect(graph.nodes.filter((n) => byId.has(n.id) && !REROUTED.has(n.id)).length).toBeGreaterThan(10);
    expect(graph.entry).toBe(dev.entry);
    // The merge request is dev's, whichever host it finds — the node is not
    // in REROUTED, so the body check above already holds the two together,
    // and a host added to one reaches the other or the test says so.
    expect(DEFAULT_WORKFLOWS["dev-auto"]).not.toContain("super-");
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

describe("the shipped blame road", () => {
  /** Memory, then the investigator, then a report — and nothing shipped. */
  const STANDINS: Record<string, string> = {
    investigator: `---
name: Investigator
inputs: [recall.brief?, base.stdout]
output:
  type: json
  schema:
    certainty: string
    related: string
    suspected: string
    confirmed: string
    fix: string
    verified: boolean
    report: string
---
Investigate {{input.task}} from {{inputs.base.stdout}} given {{inputs.recall.brief}}
`,
  };

  function standIn() {
    ensureDefaultWorkflows();
    for (const [id, source] of Object.entries(STANDINS)) saveAgent(id, source);
    return getWorkflow("blame");
  }

  const runCommand = (async (node: { id: string }) => ({ ok: true, exitCode: 0, stdout: node.id === "base" ? "abc" : "", stderr: "" })) as never;

  it("reads memory, investigates, and ends with the report — no stage, no commit, no merge request", async () => {
    const workflow = standIn();
    expect(workflow.nodes.map((n) => n.id)).toEqual(["base", "recall", "investigator", "done", "nothing-related"]);
    expect(workflow.nodes.some((n) => n.type === "command" && n.command.includes("commit"))).toBe(false);
    const provider = new FakeModelProvider((req) => {
      switch (req.context?.nodeId) {
        case "recall":
          return JSON.stringify({ brief: "Runs that touched this: run-9 (commits a..b) changed the flush rule.", sources: ["run-9-1-x"], objections: [] });
        case "investigator":
          expect(String(req.messages[0].content)).toContain("changed the flush rule");
          return JSON.stringify({ certainty: "suspected", related: "run-9", suspected: "the flush rule", confirmed: "", fix: "restore the timer", verified: false, report: "…" });
        default:
          return "{}";
      }
    });
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "Sync stopped flushing" }, emit: (e) => events.push(e) });
    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    expect(events.find((e) => e.type === "workflow.completed")).toMatchObject({ terminalNodeId: "done" });
    expect(state.outputs.investigator).toMatchObject({ certainty: "suspected" });
  });

  it("ends as nothing-related when neither memory nor history touched it", async () => {
    const workflow = standIn();
    const provider = new FakeModelProvider((req) =>
      req.context?.nodeId === "investigator"
        ? JSON.stringify({ certainty: "none", related: "", suspected: "", confirmed: "", fix: "", verified: false, report: "Nothing touched it." })
        : RECALLED,
    );
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow, { provider, runCommand, input: { task: "x" }, emit: (e) => events.push(e) });
    expect(state.status).toBe("completed");
    expect(events.find((e) => e.type === "workflow.completed")).toMatchObject({ terminalNodeId: "nothing-related" });
  });
});

describe("the shipped ask road", () => {
  const runCommand = (async (node: { id: string }) => ({
    ok: true,
    exitCode: 0,
    stdout: node.id === "base" ? "c0ffee1" : "",
    stderr: "",
  })) as never;

  const ANSWER = {
    answer: "They queue writes and flush on idle — src/sync/queue.ts:88.",
    sources: ["src/sync/queue.ts:88"],
    certainty: "answered",
  };

  it("reads one commit and answers, with nothing that could change it", () => {
    ensureDefaultWorkflows();
    const workflow = getWorkflow("ask");
    expect(workflow.nodes.map((n) => n.id)).toEqual(["base", "source-review", "done", "absent"]);
    // The guarantee is the tool list, not the prompt: a reviewer that cannot
    // write and cannot run a command is read-only however it is asked.
    const reviewer = getAgent("source-review");
    expect(reviewer.executor).toBe("gate");
    for (const tool of ["write_file", "edit_file", "run_command"]) expect(reviewer.tools).not.toContain(tool);
    expect(reviewer.tools).toContain("read_file");
    // The only command on the road reads which commit it is on.
    const commands = workflow.nodes.flatMap((n) => (n.type === "command" ? [n.command] : []));
    expect(commands).toEqual([["git", "log", "-1", "--format=format:%H"]]);
  });

  it("ends on absent when the commit holds nothing the question matches", async () => {
    ensureDefaultWorkflows();
    const input = { question: "how does sync flush?", repo: "/r", commit: "c0ffee1", memory: "nothing recorded" };
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(getWorkflow("ask"), {
      provider: new FakeModelProvider(() => JSON.stringify({ ...ANSWER, certainty: "absent" })),
      runCommand,
      input,
      emit: (e) => events.push(e),
    });
    expect(state.status).toBe("completed");
    expect(events.find((e) => e.type === "workflow.completed")).toMatchObject({ terminalNodeId: "absent" });
  });

  it("ends on done when it answered", async () => {
    ensureDefaultWorkflows();
    const state = await runWorkflow(getWorkflow("ask"), {
      provider: new FakeModelProvider((req) => {
        if (req.context?.nodeId !== "source-review") return "{}";
        // The commit and the memory brief both reach the reviewer: an answer
        // that does not know which commit it read cannot say so.
        expect(String(req.messages[0].content)).toContain("c0ffee1");
        expect(String(req.messages[0].content)).toContain("they flush on idle");
        return JSON.stringify(ANSWER);
      }),
      runCommand,
      input: { question: "how does sync flush?", repo: "/r", commit: "c0ffee1", memory: "d-1: they flush on idle" },
      emit: () => {},
    });
    expect(state.status).toBe("completed");
    expect(state.outputs["source-review"]).toMatchObject({ certainty: "answered" });
  });
});
