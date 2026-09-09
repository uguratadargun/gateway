import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GateClient } from "@/client/api";
import { next, step, type SessionRunContext } from "@/client/step";
import type { ExecutionStepRecord } from "@/executions/types";

/**
 * The person's turn, and the run being ended from outside.
 *
 * A node marked `asks: person` is handed to the session to put in front of
 * the user, and until `gate step` brings the answer back the run is waiting:
 * it reports itself paused when the node goes out and resumed when the answer
 * comes in, and the dashboard's clock is built on those two events. And a run
 * that Stop settled on the server while the session was between two calls is
 * over: the next call says so instead of carrying on against a finished row.
 */

const previousHome = process.env.GATE_HOME;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-pause-"));
  process.env.GATE_HOME = home;
  const cache = join(home, "cache", "t");
  mkdirSync(join(cache, "agents"), { recursive: true });
  mkdirSync(join(cache, "workflows"), { recursive: true });
  writeFileSync(
    join(cache, "agents", "ask.md"),
    `---
name: Ask
executor: gate
asks: person
output:
  type: json
  schema:
    answer: string
---
Ask about {{input.task}}.
`,
  );
  writeFileSync(
    join(cache, "workflows", "w.yaml"),
    `name: W
entry: ask
nodes:
  - id: ask
    type: agent
    agent: ask
    next: done
  - id: done
    type: terminal
    status: completed
`,
  );
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.GATE_HOME;
  else process.env.GATE_HOME = previousHome;
});

function fakeServer(executionId: string, settled?: { code: string; message: string }) {
  const steps: ExecutionStepRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const finished: unknown[] = [];
  const client = {
    async execution() {
      return {
        execution: {
          id: executionId,
          workflowId: "w",
          status: settled || finished.length ? "failed" : "running",
          error: settled ?? null,
          input: { task: "a thing" },
          workspace: null,
        },
        steps: [...steps],
      };
    },
    async report(_id: string, payload: { events: Array<Record<string, unknown>>; steps: ExecutionStepRecord[] }) {
      events.push(...payload.events);
      for (const s of payload.steps) steps.push({ ...s, executionId } as ExecutionStepRecord);
      return { cancelRequested: false };
    },
    async finish(_id: string, payload: unknown) {
      finished.push(payload);
    },
  } as unknown as GateClient;
  return { client, steps, events, finished };
}

function context(client: GateClient): SessionRunContext & { said: string[] } {
  const said: string[] = [];
  return { client, team: "t", say: (m) => said.push(m), said };
}

describe("a node the person answers", () => {
  it("pauses the run when it goes out and resumes it when the answer comes back", async () => {
    const server = fakeServer("p1");
    const ctx = context(server.client);

    const first = await next(ctx, "p1");
    expect(first.do).toBe("agent");
    expect(server.events.map((e) => e.type)).toEqual(["node.started", "run.paused"]);
    expect(server.events[1]).toMatchObject({ nodeId: "ask" });
    expect(ctx.said.some((l) => l.includes("paused"))).toBe(true);

    const after = await step(ctx, "p1", "ask", '{"answer": "blue"}');
    expect(after.do).toBe("done");
    // Resumed first, then the step: the clock starts again before the node is
    // counted as over, so the order on the bus reads the way it happened.
    expect(server.events.map((e) => e.type)).toEqual(["node.started", "run.paused", "run.resumed", "node.completed"]);
    expect(server.steps[0]).toMatchObject({ nodeId: "ask", status: "completed", output: { answer: "blue" } });
  });
});

describe("a run ended from outside", () => {
  it("is reported as stopped by the next call, with the marker cleared", async () => {
    // Handed out, then stopped on the dashboard while the session was away.
    const live = fakeServer("p2");
    const ctx = context(live.client);
    expect((await next(ctx, "p2")).do).toBe("agent");
    expect(existsSync(join(home, "runs", "p2.json"))).toBe(true);

    const stopped = fakeServer("p2", { code: "RUN_CANCELLED", message: "stopped from the dashboard" });
    const then = await next(context(stopped.client), "p2");
    expect(then).toMatchObject({ do: "stopped", error: { code: "RUN_CANCELLED" } });
    expect(existsSync(join(home, "runs", "p2.json"))).toBe(false);
    // Nothing was reported for a run that is over.
    expect(stopped.events).toHaveLength(0);
    expect(stopped.finished).toHaveLength(0);
  });

  it("refuses an answer for a run that has been stopped", async () => {
    const live = fakeServer("p3");
    expect((await next(context(live.client), "p3")).do).toBe("agent");

    const stopped = fakeServer("p3", { code: "RUN_CANCELLED", message: "stopped from the dashboard" });
    const then = await step(context(stopped.client), "p3", "ask", '{"answer": "blue"}');
    expect(then.do).toBe("stopped");
    expect(stopped.steps).toHaveLength(0);
  });
});
