import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GateClient } from "@/client/api";
import { continueRun, next, pinDefinitions, runScope, step, type SessionRunContext } from "@/client/step";
import type { ExecutionStepRecord } from "@/executions/types";
import { getWorkflow } from "@/workflows/registry";

/**
 * Three things a session-driven run has to get right across the many
 * processes it is spread over.
 *
 * Its definitions must not move under it: every `gate` command re-syncs the
 * mirror, so the run reads a copy frozen at `begin`. A `gate next` repeated
 * while the session still holds a node must hand back the same node with
 * the same start time, not restart its clock. And a run that failed must be
 * continuable at the node that failed, with everything before it kept.
 */

const previousHome = process.env.GATE_HOME;
let home: string;
let worktree: string;

const AGENT = `---
name: Asker
executor: gate
asks: person
output:
  type: json
  schema:
    answer: string
---
Ask about {{input.task}}.
`;

const BUILDER = `---
name: Builder
model: provider:zai/glm-5.3
executor: claude-code
output:
  type: json
  schema:
    summary: string
---
Build {{input.task}}.
`;

const WORKFLOW = `name: W
entry: ask
workspace: {}
nodes:
  - id: ask
    type: agent
    agent: asker
    next: build
  - id: build
    type: agent
    agent: builder
    next: done
  - id: done
    type: terminal
    status: completed
`;

function writeMirror(team: string, workflow = WORKFLOW) {
  const cache = join(home, "cache", team);
  mkdirSync(join(cache, "agents"), { recursive: true });
  mkdirSync(join(cache, "workflows"), { recursive: true });
  writeFileSync(join(cache, "agents", "asker.md"), AGENT);
  writeFileSync(join(cache, "agents", "builder.md"), BUILDER);
  writeFileSync(join(cache, "workflows", "w.yaml"), workflow);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-continue-"));
  process.env.GATE_HOME = home;
  worktree = mkdtempSync(join(tmpdir(), "gate-continue-wt-"));
  writeMirror("t");
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

/** The server, as far as the client can tell — including `continue`. */
function fakeServer(executionId: string) {
  const steps: ExecutionStepRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const finished: Array<{ status: string }> = [];
  let continued = 0;
  const client = {
    gatewayUrl: "http://gate.test/api/gateway",
    key: "k",
    async execution() {
      const last = finished.at(-1);
      return {
        execution: {
          id: executionId,
          workflowId: "w",
          driver: "session",
          status: last ? last.status : "running",
          error: last?.status === "failed" ? { code: "MODEL_EXECUTION_ERROR", message: "x" } : null,
          input: { task: "a thing", repo: worktree },
          workspace: { root: worktree, repo: worktree, branch: "gate/run-x", baseRef: "HEAD" },
        },
        steps: [...steps],
      };
    },
    async report(_id: string, payload: { events: Array<Record<string, unknown>>; steps: ExecutionStepRecord[] }) {
      events.push(...payload.events);
      for (const s of payload.steps) steps.push({ ...s, executionId } as ExecutionStepRecord);
      return { cancelRequested: false };
    },
    async finish(_id: string, payload: { status: string }) {
      finished.push(payload);
    },
    async continueRun() {
      // What the server does: the trailing failed steps go, the run runs again.
      const retried: string[] = [];
      while (steps.length && steps[steps.length - 1].status === "failed") retried.push(steps.pop()!.nodeId);
      finished.length = 0;
      continued++;
      return { continued: true, retried };
    },
  } as unknown as GateClient;
  return { client, steps, events, finished, continued: () => continued };
}

function context(client: GateClient, extra: Partial<SessionRunContext> = {}): SessionRunContext & { said: string[] } {
  const said: string[] = [];
  return { client, team: "t", say: (m) => said.push(m), said, ...extra };
}

describe("the definitions a run follows", () => {
  it("are frozen at begin, so a mirror that moves does not move the run", () => {
    pinDefinitions("t", "e-pin");
    const pinned = runScope("t", "e-pin");
    expect(pinned.root).toBe(join(home, "runs", "e-pin", "definitions"));
    expect(getWorkflow("w", pinned).nodes.map((n) => n.id)).toEqual(["ask", "build", "done"]);

    // The team edits the workflow on the dashboard; the next command re-syncs.
    writeMirror("t", WORKFLOW.replace("    next: build\n", "    next: done\n"));
    expect(getWorkflow("w", runScope("t", "e-pin")).nodes.map((n) => n.id)).toEqual(["ask", "build", "done"]);
    expect(getWorkflow("w", runScope("t", "e-pin")).nodes[0]).toMatchObject({ edges: [{ to: "build" }] });
    // A run that predates pinning reads the mirror, as it always did.
    expect(runScope("t", "e-never-pinned").root).toBe(join(home, "cache", "t"));
    writeMirror("t");
  });
});

describe("a node the session holds", () => {
  it("is handed out again by a repeated gate next, with its start time and without a second announcement", async () => {
    const server = fakeServer("e-again");
    const ctx = context(server.client);

    const first = await next(ctx, "e-again");
    expect(first.do).toBe("agent");
    const marker = JSON.parse(readFileSync(join(home, "runs", "e-again.json"), "utf8")) as { startedAt: number };
    expect(server.events.map((e) => e.type)).toEqual(["node.started", "run.paused"]);

    await new Promise((r) => setTimeout(r, 5));
    const again = await next(ctx, "e-again");
    expect(again.do).toBe("agent");
    const markerAgain = JSON.parse(readFileSync(join(home, "runs", "e-again.json"), "utf8")) as { startedAt: number };
    expect(markerAgain.startedAt).toBe(marker.startedAt);
    // Not started twice, not paused twice.
    expect(server.events.map((e) => e.type)).toEqual(["node.started", "run.paused"]);
    expect(ctx.said.some((m) => m.includes("still yours"))).toBe(true);

    const after = await step(ctx, "e-again", "ask", '{"answer": "blue"}');
    // The step carries the original start, so the node's duration is the person's whole answer time.
    expect(server.steps[0].startedAt).toBe(marker.startedAt);
    expect(after.do).toBe("wait");
  });
});

describe("continuing a failed run", () => {
  it("retries the node that failed, in the same worktree, with the steps before it kept", async () => {
    const server = fakeServer("e-cont");
    // A pid nothing on this machine has: the worker for `build` dies at once.
    const ctx = context(server.client, { spawnWorker: () => 4_194_000 });

    expect((await next(ctx, "e-cont")).do).toBe("agent");
    expect((await step(ctx, "e-cont", "ask", '{"answer": "blue"}')).do).toBe("wait");
    const failed = await next(ctx, "e-cont");
    expect(failed.do).toBe("failed");
    if (failed.do !== "failed") return;
    expect(failed.nodeId).toBe("build");
    expect(server.finished.at(-1)?.status).toBe("failed");
    expect(server.steps.map((s) => `${s.nodeId}:${s.status}`)).toEqual(["ask:completed", "build:failed"]);
    // Said where to go from here.
    expect(ctx.said.some((m) => m.includes("gate continue e-cont"))).toBe(true);
    expect(existsSync(join(home, "runs", "e-cont.json"))).toBe(false);

    // Continue: the failed attempt is dropped, the run is running, and the
    // walk lands on `build` again — `ask` is not asked twice.
    const alive = context(server.client, { spawnWorker: () => process.pid });
    const resumed = await continueRun(alive, "e-cont");
    expect(server.continued()).toBe(1);
    expect(resumed.do).toBe("wait");
    if (resumed.do !== "wait") return;
    expect(resumed.nodeId).toBe("build");
    expect(server.steps.map((s) => `${s.nodeId}:${s.status}`)).toEqual(["ask:completed"]);
    expect(alive.said.some((m) => m.includes("build will run again"))).toBe(true);
  });

  it("refuses a run that is over for good, and picks up one that is still going", async () => {
    const server = fakeServer("e-cont-2");
    const ctx = context(server.client, { spawnWorker: () => process.pid });
    // Still running: continue is just `next`.
    expect((await continueRun(ctx, "e-cont-2")).do).toBe("agent");

    server.finished.push({ status: "completed" });
    await expect(continueRun(ctx, "e-cont-2")).rejects.toThrow(/nothing to continue/);
  });
});
