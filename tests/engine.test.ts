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
    const state = await runWorkflow(workflow, {
      provider,
      loadAgent,
      executionId: "exec-resume-3",
      resume: {
        outputs: {},
        visitCounts: {},
        stepCount: 10_000, // already over any workflow's maxWorkflowSteps
        history: [],
        startNodeId: "implementation",
      },
    });
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("LOOP_LIMIT_EXCEEDED");
    expect(provider.calls).toHaveLength(0);
  });
});
