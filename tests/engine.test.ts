import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgent } from "@/agents/loader";
import type { AgentDefinition } from "@/agents/types";
import type { WorkflowEvent } from "@/events/types";
import { runWorkflow } from "@/runtime/engine";
import { runCommand } from "@/runtime/executors/command";
import { parseWorkflow } from "@/workflows/loader";

import { FakeModelProvider } from "./fakes/fake-model-provider";

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };

const AGENTS: Record<string, string> = {
  planner: `---
name: Planner
model: sonnet
output:
  type: json
  schema:
    plan: string
---
Plan the work.
`,
  implementation: `---
name: Implementation
model: sonnet
inputs: [planner.plan]
output:
  type: json
  schema:
    diff: string
---
Implement:

{{inputs.planner.plan}}
`,
  reviewer: `---
name: Reviewer
model: sonnet
inputs: [implementation.diff]
output:
  type: json
  schema:
    verdict: string
---
Review:

{{inputs.implementation.diff}}
`,
  security: `---
name: Security
model: opus
inputs: [implementation.diff]
output:
  type: json
  schema:
    verdict: string
---
Security review:

{{inputs.implementation.diff}}
`,
  fixer: `---
name: Fixer
model: sonnet
inputs: [visits.fix]
output:
  type: json
  schema:
    summary: string
---
Attempt {{inputs.visits.fix}}.
`,
  tester: `---
name: Tester
model: haiku
inputs: [implementation.diff]
output:
  type: json
  schema:
    passed: boolean
    failures: number
---
Test this diff:

{{inputs.implementation.diff}}
`,
};

const loadAgent = (id: string): AgentDefinition => {
  const src = AGENTS[id];
  if (!src) throw new Error(`no such agent ${id}`);
  return parseAgent(id, src, meta);
};

const PIPELINE = `
name: Dev pipeline
entry: planner
maxVisits: 3
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation
  - id: implementation
    type: agent
    agent: implementation
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

const workflow = parseWorkflow("dev", PIPELINE, meta);

function run(provider: FakeModelProvider, events: WorkflowEvent[] = []) {
  return runWorkflow(workflow, { provider, loadAgent, executionId: "exec-1", emit: (e) => events.push(e) });
}

/**
 * A step switched off in the file. What the engine must do with it: nothing at
 * all — no model call, no step, no visit — and carry on along one of the
 * node's own edges.
 */
const WITH_TESTER_OFF = parseWorkflow(
  "dev",
  `
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
    next: tester
  - id: tester
    type: agent
    agent: tester
    disabled: true
    skipTo: done
    edges:
      - when: outputs.tester.passed == true
        to: done
      - to: implementation
        label: retry
  - id: done
    type: terminal
`,
  meta,
);

describe("a node switched off", () => {
  it("is not run, not recorded, and not counted as a visit", async () => {
    const provider = new FakeModelProvider((req) =>
      req.context?.nodeId === "planner" ? '{"plan": "p"}' : '{"diff": "d"}',
    );
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(WITH_TESTER_OFF, {
      provider,
      loadAgent,
      executionId: "exec-off",
      emit: (e) => events.push(e),
    });

    expect(state.status).toBe("completed");
    expect(provider.callsFor("tester")).toHaveLength(0);
    expect(state.history.map((h) => h.nodeId)).toEqual(["planner", "implementation"]);
    // It never ran, so `visits.tester` is 0 — the count is of what happened.
    expect(state.visitCounts.tester).toBeUndefined();
    expect(state.outputs.tester).toBeUndefined();
    // Visible on the canvas as the route it took, rather than as a gap.
    expect(events).toContainEqual(expect.objectContaining({ type: "edge.selected", from: "tester", to: "done", label: "off" }));
  });

  it("can be the node a run starts at", async () => {
    const off = parseWorkflow(
      "dev",
      `
name: Dev pipeline
entry: setup
nodes:
  - id: setup
    type: command
    command: ["false"]
    disabled: true
    next: planner
  - id: planner
    type: agent
    agent: planner
    next: done
  - id: done
    type: terminal
`,
      meta,
    );
    const state = await runWorkflow(off, {
      provider: new FakeModelProvider(() => '{"plan": "p"}'),
      loadAgent,
      runCommand: async () => {
        throw new Error("a switched-off command node must not run");
      },
    });

    expect(state.status).toBe("completed");
    expect(state.history.map((h) => h.nodeId)).toEqual(["planner"]);
  });
});

describe("runWorkflow", () => {
  it("walks a linear happy path and records every node output", async () => {
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return '{"plan": "1. do the thing"}';
      if (node === "implementation") return '{"diff": "+++ patch"}';
      return '{"passed": true, "failures": 0}';
    });
    const events: WorkflowEvent[] = [];
    const state = await run(provider, events);

    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    expect(state.outputs.planner).toEqual({ plan: "1. do the thing" });
    expect(state.outputs.tester).toEqual({ passed: true, failures: 0 });
    expect(state.history.map((h) => h.nodeId)).toEqual(["planner", "implementation", "tester"]);
    expect(events.at(0)?.type).toBe("workflow.started");
    expect(events.at(-1)).toMatchObject({ type: "workflow.completed", status: "completed", terminalNodeId: "done" });
    expect(events.filter((e) => e.type === "edge.selected")).toHaveLength(3);
  });

  it("loops back to implementation when the tester fails, then completes", async () => {
    let testerCalls = 0;
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return '{"plan": "p"}';
      if (node === "implementation") return `{"diff": "attempt ${req.messages[0].content.length}"}`;
      testerCalls += 1;
      return testerCalls === 1 ? '{"passed": false, "failures": 2}' : '{"passed": true, "failures": 0}';
    });
    const state = await run(provider);

    expect(state.status).toBe("completed");
    expect(state.visitCounts).toEqual({ planner: 1, implementation: 2, tester: 2 });
    expect(state.history.map((h) => h.nodeId)).toEqual(["planner", "implementation", "tester", "implementation", "tester"]);
    expect(provider.callsFor("implementation")).toHaveLength(2);
  });

  it("stops with LOOP_LIMIT_EXCEEDED when a node never passes", async () => {
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return '{"plan": "p"}';
      if (node === "implementation") return '{"diff": "d"}';
      return '{"passed": false, "failures": 1}';
    });
    const events: WorkflowEvent[] = [];
    const state = await run(provider, events);

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("LOOP_LIMIT_EXCEEDED");
    expect(state.visitCounts.implementation).toBe(4); // maxVisits 3 + the attempt that trips it
    expect(events.at(-1)).toMatchObject({ type: "workflow.failed", code: "LOOP_LIMIT_EXCEEDED" });
    // "ran 4 times" alone does not say why; the gate that kept refusing does.
    expect(state.error?.message).toContain('last sent back by "tester"');
    expect(state.error?.message).toContain("tests failed");
  });

  it("fails the run when an agent's output does not match its declared schema", async () => {
    const provider = new FakeModelProvider((req) => (req.context?.nodeId === "planner" ? '{"plan": "p"}' : "sorry, I cannot help"));
    const events: WorkflowEvent[] = [];
    const state = await run(provider, events);

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("AGENT_OUTPUT_VALIDATION_ERROR");
    expect(state.history.at(-1)).toMatchObject({ nodeId: "implementation", status: "failed" });
    expect(events.some((e) => e.type === "node.failed")).toBe(true);
  });

  it("hands an agent only its declared inputs", async () => {
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return '{"plan": "SECRET-PLAN"}';
      if (node === "implementation") return '{"diff": "+++ patch"}';
      return '{"passed": true, "failures": 0}';
    });
    await run(provider);

    const tester = provider.callsFor("tester")[0];
    expect(tester.messages[0].content).toContain("+++ patch");
    expect(tester.messages[0].content).not.toContain("SECRET-PLAN");
    expect(tester.model).toBe("haiku");
  });

  it("recovers a JSON object from a fenced, chatty answer", async () => {
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return '{"plan": "p"}';
      if (node === "implementation") return 'Sure!\n```json\n{"diff": "+++ p"}\n```\nHope that helps.';
      return '{"passed": true, "failures": 0}';
    });
    const state = await run(provider);
    expect(state.status).toBe("completed");
    expect(state.outputs.implementation).toEqual({ diff: "+++ p" });
  });

  it("takes a clean JSON answer whole, even when its strings contain fences", async () => {
    // A planner's notes quote code. The fence heuristic, applied first, took
    // the text between two fences inside a string value and refused a valid
    // answer; the whole text is tried before any heuristic.
    const notes = "Read a.ts:\n```ts\nconst a = 1;\n```\nand b.ts:\n```ts\nconst b = 2;\n```\n";
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return JSON.stringify({ plan: notes });
      if (node === "implementation") return JSON.stringify({ diff: "+++ p" });
      return '{"passed": true, "failures": 0}';
    });
    const state = await run(provider);
    expect(state.status).toBe("completed");
    expect(state.outputs.planner).toEqual({ plan: notes });
  });

  it("runs command nodes and branches on the exit code without a shell", async () => {
    const src = `
name: Build
entry: build
nodes:
  - id: build
    type: command
    command: [npm, run, build]
    edges:
      - when: outputs.build.ok == true
        to: done
      - to: broken
  - id: done
    type: terminal
  - id: broken
    type: terminal
    status: failed
`;
    const wf = parseWorkflow("build", src, meta);
    const provider = new FakeModelProvider(() => "");
    const state = await runWorkflow(wf, {
      provider,
      loadAgent,
      runCommand: async () => ({ exitCode: 1, ok: false, stdout: "", stderr: "boom" }),
    });
    expect(state.status).toBe("failed");
    expect(state.outputs.build).toMatchObject({ exitCode: 1, ok: false, stderr: "boom" });
    expect(provider.calls).toHaveLength(0);
  });
});

const PARALLEL_PIPELINE = `
name: Parallel checks
entry: planner
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation
  - id: implementation
    type: agent
    agent: implementation
    next: checks
  - id: checks
    type: parallel
    branches: [reviewer, security]
    join: verdict
  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict
  - id: security
    type: agent
    agent: security
    next: verdict
  - id: verdict
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
      - to: rejected
  - id: done
    type: terminal
  - id: rejected
    type: terminal
    status: failed
`;

describe("parallel nodes", () => {
  it("starts both branches before either finishes, then joins", async () => {
    const workflow = parseWorkflow("parallel", PARALLEL_PIPELINE, meta);

    // The barrier only opens once two agent calls are in flight at the same
    // time, so this test cannot pass on a sequential engine.
    let open = () => {};
    const bothInFlight = new Promise<void>((resolve) => (open = resolve));
    let inFlight = 0;

    const provider = new FakeModelProvider(async (req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return JSON.stringify({ plan: "do it" });
      if (node === "implementation") return JSON.stringify({ diff: "--- a\n+++ b\n" });
      if (++inFlight === 2) open();
      await bothInFlight;
      return JSON.stringify({ verdict: "approved" });
    });

    const events: WorkflowEvent[] = [];
    const state = await Promise.race([
      runWorkflow(workflow, { provider, loadAgent, emit: (e) => events.push(e) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("branches did not overlap")), 2000)),
    ]);

    expect(state.status).toBe("completed");
    expect(state.outputs.reviewer).toEqual({ verdict: "approved" });
    expect(state.outputs.security).toEqual({ verdict: "approved" });
    // The parallel node itself routes; it contributes no state of its own.
    expect(state.outputs.checks).toBeUndefined();
    expect(events.filter((e) => e.type === "node.started").map((e) => e.nodeId)).toContain("checks");
    expect(events.some((e) => e.type === "edge.selected" && e.from === "checks" && e.to === "reviewer")).toBe(true);
    expect(events.some((e) => e.type === "edge.selected" && e.from === "checks" && e.to === "verdict")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "workflow.completed", terminalNodeId: "done" });
  });

  it("fails the run when one branch fails, after the other has unwound", async () => {
    const workflow = parseWorkflow("parallel", PARALLEL_PIPELINE, meta);
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "planner") return JSON.stringify({ plan: "do it" });
      if (node === "implementation") return JSON.stringify({ diff: "--- a\n+++ b\n" });
      if (node === "security") return "not json at all";
      return JSON.stringify({ verdict: "approved" });
    });

    const state = await runWorkflow(workflow, { provider, loadAgent });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("AGENT_OUTPUT_VALIDATION_ERROR");
    expect(state.history.find((s) => s.nodeId === "reviewer")?.status).toBe("completed");
    expect(state.history.find((s) => s.nodeId === "security")?.status).toBe("failed");
    // The join is never reached, so the workflow does not continue past it.
    expect(state.history.some((s) => s.nodeId === "verdict")).toBe(false);
  });
});

describe("cancellation", () => {
  const workflow = () => parseWorkflow("pipeline", PIPELINE, meta);

  it("does not start a run whose signal is already aborted", async () => {
    const provider = new FakeModelProvider(() => '{"plan":"x"}');
    const state = await runWorkflow(workflow(), {
      provider,
      loadAgent,
      signal: AbortSignal.abort(),
    });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("RUN_CANCELLED");
    // Nothing was asked of the model: the check happens before the first node.
    expect(provider.calls).toHaveLength(0);
    expect(state.history).toHaveLength(0);
  });

  it("stops at the next node once cancelled, keeping what already finished", async () => {
    const controller = new AbortController();
    // Cancel while the first node is being answered.
    const provider = new FakeModelProvider((_req, i) => {
      if (i === 0) {
        controller.abort();
        return '{"plan":"x"}';
      }
      return '{"diff":"y"}';
    });

    const state = await runWorkflow(workflow(), {
      provider,
      loadAgent,
      signal: controller.signal,
    });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("RUN_CANCELLED");
    // The planner finished and is kept; the implementation never ran.
    expect(state.history.map((h) => h.nodeId)).toEqual(["planner"]);
    expect(state.outputs.planner).toEqual({ plan: "x" });
    expect(provider.calls).toHaveLength(1);
  });

  it("reports the cancellation as a workflow failure event", async () => {
    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(workflow(), {
      provider: new FakeModelProvider(() => '{"plan":"x"}'),
      loadAgent,
      signal: AbortSignal.abort(),
      emit: (e) => events.push(e),
    });

    expect(state.status).toBe("failed");
    const failed = events.find((e) => e.type === "workflow.failed");
    expect(failed).toMatchObject({ code: "RUN_CANCELLED" });
  });
});


describe("uncapped by request", () => {
  it("lets a command node declare timeoutMs: 0 and run untimed", async () => {
    // Omitting the field gets the one-hour default, not "no timeout"; 0 is how
    // you say "as long as it takes", and execFile reads it as none.
    const node = { id: "wait", type: "command", command: ["sleep", "0.3"], timeoutMs: 0, edges: [] } as Parameters<
      typeof runCommand
    >[0];
    await expect(runCommand(node)).resolves.toMatchObject({ ok: true });
  });

  it("runs a node more times than the old maxVisits ceiling when nothing caps it", async () => {
    // maxVisits used to default to 5 and could never be raised past 50; a
    // review loop on a long task legitimately goes round more often than that.
    let attempts = 0;
    const provider = new FakeModelProvider((req) => {
      const nodeId = req.context?.nodeId;
      if (nodeId === "planner") return '{"plan": "p"}';
      if (nodeId === "implementation") return '{"diff": "d"}';
      attempts++;
      return attempts < 60 ? '{"passed": false, "failures": 1}' : '{"passed": true, "failures": 0}';
    });
    const uncapped = parseWorkflow("dev", PIPELINE.replace("maxVisits: 3\n", ""), meta);
    const state = await runWorkflow(uncapped, { provider, loadAgent });

    expect(state.status).toBe("completed");
    expect(state.visitCounts.implementation).toBe(60);
  });
});

describe("a command that carries what a node produced", () => {
  it("fills {{outputs}} and {{input}} into argv, one argument at a time", async () => {
    // Without this a command node could only be written as a constant, so a
    // pipeline that needed to commit with the implementer's own summary had to
    // reach for an agent to run git — a model doing a deterministic job.
    const wf = parseWorkflow(
      "w",
      `name: Ship
entry: planner
nodes:
  - id: planner
    type: agent
    agent: planner
    next: ship
  - id: ship
    type: command
    command: [echo, "{{input.task}}", "plan: {{outputs.planner.plan}}"]
    next: done
  - id: done
    type: terminal
`,
      meta,
    );
    const seen: string[][] = [];
    const state = await runWorkflow(wf, {
      provider: new FakeModelProvider(() => '{"plan": "a plan with spaces"}'),
      loadAgent,
      input: { task: "do the thing" },
      runCommand: async (node) => {
        seen.push(node.command);
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(state.status).toBe("completed");
    // One argument stays one argument however many spaces the value had, so
    // nothing is ever re-split and no shell quoting is involved.
    expect(seen[0]).toEqual(["echo", "do the thing", "plan: a plan with spaces"]);
  });

  it("fails the node when a command references something that was never produced", async () => {
    const wf = parseWorkflow(
      "w",
      `name: Ship
entry: ship
nodes:
  - id: ship
    type: command
    command: [echo, "{{outputs.nobody.nothing}}"]
    next: done
  - id: done
    type: terminal
`,
      meta,
    );
    const state = await runWorkflow(wf, {
      provider: new FakeModelProvider(() => "{}"),
      loadAgent,
      runCommand: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(state.status).toBe("failed");
    expect(state.error?.message).toMatch(/unresolved template/);
  });
});

describe("a worktree that disappears", () => {
  it("stops with the directory named, rather than with a child that produced no output", async () => {
    // Removed by hand, or by a cleanup that did not check for live runs. Before
    // this the run carried on until some child happened to need the directory,
    // and then died saying only "exited without a code — no output", which sent
    // a real investigation at the wrong thing entirely.
    const gone = join(tmpdir(), `gate-gone-${Date.now()}`);
    const provider = new FakeModelProvider(() => '{"plan": "p"}');
    const state = await runWorkflow(workflow, {
      provider,
      loadAgent,
      workspace: { root: gone, repo: gone, branch: "gate/run-x", baseRef: "HEAD" },
    });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("WORKSPACE_ERROR");
    expect(state.error?.message).toContain(gone);
    // It refuses before spending anything on the node.
    expect(provider.calls).toHaveLength(0);
  });
});

describe("spend budget", () => {
  it("halts a run that goes over maxCostUsd, and says what it spent", async () => {
    // The ceiling worth having: how many rounds a task needs is unknowable up
    // front, what you will pay for it is not. Sonnet output bills $10/Mtok, so
    // 300k output tokens a step is $3 — the second step crosses a $5 budget.
    const provider = new FakeModelProvider((req) => {
      const nodeId = req.context?.nodeId;
      const text =
        nodeId === "planner" ? '{"plan": "p"}' : nodeId === "implementation" ? '{"diff": "d"}' : '{"passed": true, "failures": 0}';
      return { text, usage: { inputTokens: 0, outputTokens: 300_000, cacheReadTokens: 0 } };
    });
    const capped = parseWorkflow("dev", `maxCostUsd: 5\n${PIPELINE}`, meta);
    const state = await runWorkflow(capped, { provider, loadAgent });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("BUDGET_EXCEEDED");
    expect(state.error?.message).toMatch(/\$6\.00.*\$5\.00/);
    // Stopped between nodes, not part-way through one: both steps it paid for
    // are in the history, and "tester" was never started.
    expect(state.history).toHaveLength(2);
    expect(provider.callsFor("tester")).toHaveLength(0);
  });

  it("does not refill the budget when a run is continued", async () => {
    const provider = new FakeModelProvider(() => '{"diff":"y"}');
    const capped = parseWorkflow("dev", `maxCostUsd: 5\n${PIPELINE}`, meta);
    const state = await runWorkflow(capped, {
      provider,
      loadAgent,
      resume: {
        outputs: { planner: { plan: "p" } },
        visitCounts: {},
        stepCount: 1,
        // The lineage already spent $6 of a $5 budget.
        history: [
          {
            nodeId: "planner",
            stepIndex: 0,
            visit: 1,
            startedAt: 0,
            finishedAt: 1,
            status: "completed",
            input: null,
            output: { plan: "p" },
            usage: { model: "sonnet", inputTokens: 0, outputTokens: 600_000, cacheReadTokens: 0 },
          },
        ],
        startNodeId: "implementation",
      },
    });

    expect(state.error?.code).toBe("BUDGET_EXCEEDED");
    // One node ran — continuing is allowed to make progress, then stops.
    expect(provider.calls).toHaveLength(1);
  });

  it("leaves a run alone when no budget is declared", async () => {
    const provider = new FakeModelProvider((req) => {
      const nodeId = req.context?.nodeId;
      if (nodeId === "planner") return { text: '{"plan": "p"}', usage: { inputTokens: 0, outputTokens: 900_000, cacheReadTokens: 0 } };
      if (nodeId === "implementation") return '{"diff": "d"}';
      return '{"passed": true, "failures": 0}';
    });
    const state = await runWorkflow(workflow, { provider, loadAgent });
    expect(state.status).toBe("completed");
  });
});

describe("cancelling a command node", () => {
  it("kills the child process rather than leaving it running", async () => {
    const node = { id: "wait", type: "command", command: ["sleep", "5"], edges: [] } as Parameters<typeof runCommand>[0];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(runCommand(node, { signal: controller.signal })).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    // It came back on the abort, not after the command's own five seconds.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("resuming", () => {
  it("starts at the given node instead of the entry, with the seeded state available to it", async () => {
    const provider = new FakeModelProvider((req) => {
      const node = req.context?.nodeId;
      if (node === "implementation") return '{"diff":"from resume"}';
      if (node === "tester") return '{"passed":true,"failures":0}';
      return "unexpected node";
    });

    const state = await runWorkflow(workflow, {
      provider,
      loadAgent,
      executionId: "exec-resume-1",
      resume: {
        outputs: { planner: { plan: "already planned" } },
        visitCounts: { planner: 1 },
        stepCount: 1,
        history: [],
        startNodeId: "implementation",
      },
    });

    expect(state.status).toBe("completed");
    // The planner never ran again; resuming picked up after it.
    expect(provider.calls).toHaveLength(2);
    expect(state.history.map((h) => h.nodeId)).toEqual(["implementation", "tester"]);
    // stepIndex continues from the seeded count rather than restarting at 0.
    expect(state.history[0].stepIndex).toBe(1);
  });

  it("halts immediately, at no cost, when the seeded visit count is already at the ceiling", async () => {
    const provider = new FakeModelProvider(() => '{"diff":"y"}');

    const state = await runWorkflow(workflow, {
      provider,
      loadAgent,
      executionId: "exec-resume-2",
      resume: {
        outputs: {},
        // maxVisits is 3 on this fixture; seeding it already there must not
        // buy the node a fresh set of attempts.
        visitCounts: { implementation: 3 },
        stepCount: 10,
        history: [],
        startNodeId: "implementation",
      },
    });

    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("LOOP_LIMIT_EXCEEDED");
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps maxWorkflowSteps a real ceiling across a resume", async () => {
    const provider = new FakeModelProvider(() => '{"diff":"y"}');
    // A cap only exists when the workflow asks for one, so this fixture asks.
    const capped = parseWorkflow("dev", `maxWorkflowSteps: 20\n${PIPELINE}`, meta);
    const state = await runWorkflow(capped, {
      provider,
      loadAgent,
      executionId: "exec-resume-3",
      resume: {
        outputs: {},
        visitCounts: {},
        stepCount: 10_000, // already well over the 20 above
        history: [],
        startNodeId: "implementation",
      },
    });
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("LOOP_LIMIT_EXCEEDED");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("a loop that is given an end", () => {
  // `maxVisits` is the engine's ceiling: it fails the whole run and says only
  // that a node repeated. A pipeline that knows how many attempts a fix is
  // worth should be able to say so itself, and land somewhere that reports
  // what is stuck — which is what `visits.<node>` on an edge is for.
  const BOUNDED = `
name: Bounded retries
entry: fix
nodes:
  - id: fix
    type: agent
    agent: fixer
    next: tests
  - id: tests
    type: command
    command: [echo, hi]
    edges:
      - when: outputs.tests.ok == true
        to: done
      - when: visits.tests >= 3
        to: gave-up
      - to: fix
  - id: done
    type: terminal
  - id: gave-up
    type: terminal
    status: failed
`;

  const red = async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "still red" });

  it("stops at the terminal the pipeline named, not at the engine's ceiling", async () => {
    const state = await runWorkflow(parseWorkflow("bounded", BOUNDED, meta), {
      provider: new FakeModelProvider(() => '{"summary": "tried"}'),
      loadAgent,
      runCommand: red,
    });

    // A deliberate terminal, so there is no error code and nothing to resume:
    // the run did not hit a limit, it decided.
    expect(state.status).toBe("failed");
    expect(state.error).toBeNull();
    expect(state.visitCounts).toMatchObject({ fix: 3, tests: 3 });
  });

  it("hands an agent the attempt it is on, counting from one", async () => {
    const provider = new FakeModelProvider(() => '{"summary": "tried"}');
    await runWorkflow(parseWorkflow("bounded", BOUNDED, meta), { provider, loadAgent, runCommand: red });

    // The count is incremented before the node runs, so a node always reads
    // its own visit as the attempt in progress rather than the one before it.
    expect(provider.callsFor("fix").map((c) => c.messages[0].content)).toEqual(["Attempt 1.", "Attempt 2.", "Attempt 3."]);
  });

  it("reads zero for a node that has not run, rather than refusing to compare", async () => {
    const wf = parseWorkflow(
      "zero",
      `name: Zero
entry: gate
nodes:
  - id: gate
    type: condition
    edges:
      - when: visits.later >= 1
        to: never
      - to: later
  - id: later
    type: command
    command: [echo, hi]
    next: done
  - id: never
    type: terminal
    status: failed
  - id: done
    type: terminal
`,
      meta,
    );
    const state = await runWorkflow(wf, {
      provider: new FakeModelProvider(() => "{}"),
      loadAgent,
      runCommand: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(state.status).toBe("completed");
    expect(state.history.map((h) => h.nodeId)).toEqual(["gate", "later"]);
  });
});
