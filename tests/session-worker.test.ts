import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GateClient } from "@/client/api";
import { next, step, work, wait, type SessionRunContext } from "@/client/step";
import { syncSubagents } from "@/client/subagents";
import type { ExecutionStepRecord } from "@/executions/types";

/**
 * A session-driven run whose agent runs in its own model.
 *
 * An agent with `executor: claude-code` is not the session's to do — its model
 * (a GLM, a local one) is not the session's model — so `gate next` starts a
 * detached worker for it and says `wait`; the worker runs the node through the
 * executor and records the step itself; the next `gate next` moves on. What
 * has to hold: one worker per node, not one per `gate next`; a worker that
 * died is a failed step with the log named, not a node started over; and the
 * session's `gate step` is never involved.
 */

const previousHome = process.env.GATE_HOME;
let home: string;
let worktree: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-worker-"));
  process.env.GATE_HOME = home;
  worktree = mkdtempSync(join(tmpdir(), "gate-worker-wt-"));
  // The team's definitions, as `gate pull` would have mirrored them.
  const cache = join(home, "cache", "t");
  mkdirSync(join(cache, "agents"), { recursive: true });
  mkdirSync(join(cache, "workflows"), { recursive: true });
  writeFileSync(
    join(cache, "agents", "builder.md"),
    `---
name: Builder
model: provider:zai/glm-5.3
executor: claude-code
output:
  type: json
  schema:
    summary: string
---
Build {{input.task}}.
`,
  );
  writeFileSync(
    join(cache, "workflows", "w.yaml"),
    `name: W
entry: build
workspace: {}
nodes:
  - id: build
    type: agent
    agent: builder
    next: done
  - id: done
    type: terminal
    status: completed
`,
  );
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

/** The server, as far as the client can tell: a run, its steps, what it was told. */
function fakeServer(executionId: string) {
  const steps: ExecutionStepRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const finished: unknown[] = [];
  const client = {
    gatewayUrl: "http://gate.test/api/gateway",
    key: "k",
    async execution() {
      return {
        execution: {
          id: executionId,
          workflowId: "w",
          status: finished.length ? "completed" : "running",
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
    async finish(_id: string, payload: unknown) {
      finished.push(payload);
    },
  } as unknown as GateClient;
  return { client, steps, events, finished };
}

/** A stand-in for the Claude Code CLI: one tool call, then the answer. */
function fakeCli(result: string) {
  const stream = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "isOnline" } }] } },
    { type: "user", message: { content: [{ tool_use_id: "t1", type: "tool_result", content: "ts/a.ts:12" }] } },
    { type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 1, output_tokens: 1 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  return ((_cmd: string, args: string[]) => {
    (fakeCli as unknown as { lastArgs: string[] }).lastArgs = args;
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = Readable.from([stream]);
    child.stderr = Readable.from([""]);
    child.kill = () => true;
    setTimeout(() => child.emit("close", 0), 0);
    return child;
  }) as never;
}

function context(client: GateClient, extra: Partial<SessionRunContext> = {}): SessionRunContext & { said: string[] } {
  const said: string[] = [];
  return { client, team: "t", say: (m) => said.push(m), said, ...extra };
}

describe("a claude-code node in a session-driven run", () => {
  it("is started once as a worker, followed with wait, recorded by the worker, and then moved past", async () => {
    const server = fakeServer("e1");
    const spawned: string[] = [];
    const ctx = context(server.client, {
      // Alive, and not a real worker: this test runs the work itself below.
      spawnWorker: (_e, nodeId) => (spawned.push(nodeId), process.pid),
      spawnCli: fakeCli('{"summary": "built it"}'),
    });

    const first = await next(ctx, "e1");
    expect(first.do).toBe("wait");
    if (first.do !== "wait") return;
    expect(first.model).toBe("provider:zai/glm-5.3");
    expect(existsSync(first.log)).toBe(true);
    expect(spawned).toEqual(["build"]);
    // Announced as started, so the dashboard lights the node up while it runs.
    expect(server.events.map((e) => e.type)).toEqual(["node.started"]);

    // A second `gate next` while the worker runs finds it, and does not start another.
    const again = await next(ctx, "e1");
    expect(again.do).toBe("wait");
    expect(spawned).toEqual(["build"]);

    // The worker: runs the node in the agent's model, through the gateway.
    expect(await work(ctx, "e1", "build")).toBe(true);
    const args = (fakeCli as unknown as { lastArgs: string[] }).lastArgs;
    expect(args[args.indexOf("--model") + 1]).toBe("provider:zai/glm-5.3");
    expect(server.steps).toHaveLength(1);
    expect(server.steps[0]).toMatchObject({ nodeId: "build", status: "completed", output: { summary: "built it" } });
    // Its tool calls reached the dashboard and the log the session follows.
    expect(server.events.some((e) => e.type === "tool.called" && e.tool === "Grep")).toBe(true);
    const log = readFileSync(first.log, "utf8");
    expect(log).toContain("Grep");
    expect(log).toContain("✓ build");

    // With the step recorded, the walk moves on — here, to the end.
    const after = await wait(ctx, "e1", 10);
    expect(after.do).toBe("done");
    expect(server.finished).toHaveLength(1);
  });

  it("fails the node, naming the log, when the worker died without reporting", async () => {
    const server = fakeServer("e2");
    // A pid nothing on this machine has: the worker is gone.
    const ctx = context(server.client, { spawnWorker: () => 4_194_000 });

    const first = await next(ctx, "e2");
    expect(first.do).toBe("wait");

    const then = await next(ctx, "e2");
    expect(then.do).toBe("failed");
    if (then.do !== "failed") return;
    expect(then.nodeId).toBe("build");
    expect(then.error.message).toContain("exited without reporting");
    expect(then.error.message).toContain(".log");
    expect(server.steps).toHaveLength(1);
    expect(server.steps[0].status).toBe("failed");
  });

  it("hands back wait again when the slice runs out, having printed what the log gained", async () => {
    const server = fakeServer("e3");
    const ctx = context(server.client, { spawnWorker: () => process.pid });

    const first = await next(ctx, "e3");
    expect(first.do).toBe("wait");
    if (first.do !== "wait") return;
    writeFileSync(first.log, "12:00:00   Read {\"file\":\"a.ts\"} → 1 line\n", { flag: "a" });

    const slice = await wait(ctx, "e3", 50);
    expect(slice.do).toBe("wait");
    expect(ctx.said.some((m) => m.includes("Read"))).toBe(true);
    // Shown once: the next slice prints only what is new.
    const before = ctx.said.length;
    const again = await wait(ctx, "e3", 50);
    expect(again.do).toBe("wait");
    expect(ctx.said.length).toBe(before);
  });
});

describe("the same node when the session itself runs through the gateway", () => {
  it("is handed to the session as a subagent, in the agent's model, and answered with gate step", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-claude-"));
    try {
      const server = fakeServer("e4");
      const spawned: string[] = [];
      const ctx = context(server.client, { throughGateway: true, spawnWorker: (_e, n) => (spawned.push(n), process.pid) });

      // What `gate next` does before every instruction on such a session.
      const synced = syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" });
      expect(synced.created).toBe(true);
      expect(synced.written).toEqual(["gate-t-builder"]);
      const file = readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "agents", "gate-t-builder.md"), "utf8");
      expect(file).toContain("name: gate-t-builder");
      expect(file).toContain("model: provider:zai/glm-5.3");
      // Unchanged content is not rewritten: Claude Code watches the directory.
      expect(syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" }).written).toEqual([]);

      const first = await next(ctx, "e4");
      expect(first.do).toBe("delegate");
      if (first.do !== "delegate") return;
      expect(first.subagent).toBe("gate-t-builder");
      expect(first.model).toBe("provider:zai/glm-5.3");
      expect(first.prompt).toContain("Build a thing.");
      expect(first.prompt).toContain("running unattended");
      expect(first.workspace).toBe(worktree);
      expect(first.remember.some((r) => r.includes("gate step e4 build"))).toBe(true);
      // No worker: the session runs it.
      expect(spawned).toEqual([]);
      expect(existsSync(join(home, "runs", "e4.json"))).toBe(true);

      const after = await step(ctx, "e4", "build", '{"summary": "built live"}');
      expect(after.do).toBe("done");
      expect(server.steps[0]).toMatchObject({ nodeId: "build", status: "completed", output: { summary: "built live" } });
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });
});
