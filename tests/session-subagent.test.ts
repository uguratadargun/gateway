import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GateClient } from "@/client/api";
import { next, outputFileFor, recallSubagent, step, type SessionRunContext } from "@/client/step";
import { syncSubagents } from "@/client/subagents";
import type { ExecutionStepRecord } from "@/executions/types";

/**
 * A session-driven run whose agent runs in its own model.
 *
 * An agent with `executor: claude-code` is not the session's to do — its
 * model is its own — so `gate next` hands it to the session as a subagent in
 * that model, on the person's own Claude login, and the session hands the
 * subagent's answer back with `gate step`. What has to hold: the subagent is
 * the file gate mirrored, its next pass continues it with only what changed,
 * and the one name that resolves to nobody is refused.
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
model: opus
effort: high
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
  // A node that reads its own last answer: its second pass has something new
  // to be given, which is what a resume is supposed to carry.
  writeFileSync(
    join(cache, "agents", "reviser.md"),
    `---
name: Reviser
model: opus
executor: claude-code
inputs: [revise.summary?]
output:
  type: json
  schema:
    summary: string
---
Build {{input.task}}, the long way round, with everything that takes.

Where the last pass got to: {{inputs.revise.summary}}
`,
  );
  writeFileSync(
    join(cache, "workflows", "revise.yaml"),
    `name: Revise
entry: revise
workspace: {}
nodes:
  - id: revise
    type: agent
    agent: reviser
    edges:
      - when: visits.revise >= 2
        to: done
      - to: revise
  - id: done
    type: terminal
    status: completed
`,
  );
  // The same node twice: the second pass is the first subagent continued.
  writeFileSync(
    join(cache, "workflows", "twice.yaml"),
    `name: Twice
entry: build
workspace: {}
nodes:
  - id: build
    type: agent
    agent: builder
    edges:
      - when: visits.build >= 2
        to: done
      - to: build
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
function fakeServer(executionId: string, workflowId = "w") {
  const steps: ExecutionStepRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const finished: unknown[] = [];
  const client = {
    key: "k",
    async execution() {
      return {
        execution: {
          id: executionId,
          workflowId,
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

function context(client: GateClient, extra: Partial<SessionRunContext> = {}): SessionRunContext & { said: string[] } {
  const said: string[] = [];
  return { client, team: "t", say: (m) => said.push(m), said, ...extra };
}

describe("a claude-code node in a session-driven run", () => {
  it("is handed to the session as a subagent, in the agent's model, and answered with gate step", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-claude-"));
    try {
      const server = fakeServer("e4");
      const ctx = context(server.client);

      // What every `gate next` does before its instruction.
      const synced = syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" });
      expect(synced.created).toBe(true);
      expect(synced.written).toEqual(["gate-t-builder", "gate-t-reviser"]);
      const file = readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "agents", "gate-t-builder.md"), "utf8");
      expect(file).toContain("name: gate-t-builder");
      expect(file).toContain("model: opus");
      // The effort rides the file too: nothing else carries it to a subagent,
      // and without it the node thinks as hard as the session happens to.
      expect(file).toContain("effort: high");
      // An agent that names no effort leaves it to the session.
      expect(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "agents", "gate-t-reviser.md"), "utf8")).not.toContain(
        "effort:",
      );
      // The subagent is told its own subagents run in the background here, and
      // how reading a file costs what it costs. Both ride the mirror file
      // because a subagent gets no appended system prompt.
      expect(file).toContain("run in the background");
      expect(file).toContain("Never dispatch a subagent type that copies your own context");
      expect(file).toContain("Read files with Read");
      // Unchanged content is not rewritten: Claude Code watches the directory.
      expect(syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" }).written).toEqual([]);

      const first = await next(ctx, "e4");
      expect(first.do).toBe("delegate");
      if (first.do !== "delegate") return;
      expect(first.subagent).toBe("gate-t-builder");
      expect(first.model).toBe("opus");
      expect(first.prompt).toContain("Build a thing.");
      expect(first.prompt).toContain("running unattended");
      expect(first.workspace).toBe(worktree);
      expect(first.remember.some((r) => r.includes("gate step e4 build"))).toBe(true);
      // The subagent writes its own answer file, under the run's directory,
      // and the session hands that file back rather than retyping it.
      expect(first.outputFile).toBe(outputFileFor("e4", "build", 1));
      expect(first.outputFile).toContain(join("runs", "e4", "out", "build-1.json"));
      expect(first.prompt).toContain(first.outputFile);
      expect(first.remember.some((r) => r.includes(`--output-file ${first.outputFile}`))).toBe(true);
      expect(first.remember.some((r) => r.includes("--subagent"))).toBe(true);
      // A first pass: nothing to continue.
      expect(first.resume).toBeNull();
      expect(existsSync(join(home, "runs", "e4.json"))).toBe(true);

      const after = await step(ctx, "e4", "build", '{"summary": "built live"}', { subagent: "a1b2c3" });
      expect(after.do).toBe("done");
      expect(server.steps[0]).toMatchObject({ nodeId: "build", status: "completed", output: { summary: "built live" } });
      // The run is over, and everything on this machine about it went with it.
      expect(recallSubagent("e4", "build")).toBeNull();
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  it("continues the same subagent on the node's next pass, and starts fresh when none was named", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-claude-"));
    try {
      const server = fakeServer("e5", "twice");
      const ctx = context(server.client);
      syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" });

      const first = await next(ctx, "e5");
      expect(first.do).toBe("delegate");
      if (first.do !== "delegate") return;
      expect(first.resume).toBeNull();
      const second = await step(ctx, "e5", "build", '{"summary": "pass one"}', { subagent: "agent-one" });
      expect(recallSubagent("e5", "build")).toBe("agent-one");
      expect(second.do).toBe("delegate");
      if (second.do !== "delegate") return;
      // The second pass continues the first pass's subagent, with everything
      // it read still there, and its answer goes to a file of its own.
      expect(second.resume).toBe("agent-one");
      expect(second.remember.some((r) => r.includes('SendMessage') && r.includes('"agent-one"'))).toBe(true);
      expect(second.outputFile).toBe(outputFileFor("e5", "build", 2));
      expect(second.outputFile).not.toBe(first.outputFile);
      // Handed back without naming a subagent: the next pass would start fresh.
      const done = await step(ctx, "e5", "build", '{"summary": "pass two"}');
      expect(done.do).toBe("done");
      expect(recallSubagent("e5", "build")).toBeNull();

      // A run whose first pass named nothing has nothing to continue.
      const other = fakeServer("e6", "twice");
      const octx = context(other.client);
      const o1 = await next(octx, "e6");
      if (o1.do !== "delegate") return;
      const o2 = await step(octx, "e6", "build", '{"summary": "pass one"}');
      expect(o2.do).toBe("delegate");
      if (o2.do !== "delegate") return;
      expect(o2.resume).toBeNull();
      expect(o2.remember[0]).toContain("Start the subagent");
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  /**
   * A continued subagent already holds the brief. Sending it again was
   * measured at 52,146 characters re-sent to deliver about 4,500 characters of
   * new material, and a 250-second gap in the driving session while that was
   * assembled and relayed — the single largest delay in the run.
   */
  it("sends a continued subagent only what changed, and --full is the way back to the whole brief", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-claude-"));
    try {
      const server = fakeServer("e8", "revise");
      const ctx = context(server.client);
      syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" });

      const first = await next(ctx, "e8");
      expect(first.do).toBe("delegate");
      if (first.do !== "delegate") return;
      expect(first.prompt).toContain("the long way round");

      const second = await step(ctx, "e8", "revise", '{"summary": "pass one"}', { subagent: "agent-one" });
      expect(second.do).toBe("delegate");
      if (second.do !== "delegate") return;
      expect(second.resume).toBe("agent-one");

      // What moved, and not the brief that did not.
      expect(second.prompt).toContain("revise.summary");
      expect(second.prompt).toContain("pass one");
      expect(second.prompt).not.toContain("the long way round");
      expect(second.prompt.length).toBeLessThan(first.prompt.length);
      // Still says where the answer goes, and it is this pass's own file.
      expect(second.prompt).toContain(second.outputFile);
      expect(second.outputFile).toBe(outputFileFor("e8", "revise", 2));
      // A delta is no use to a fresh agent, and the session is told the way out.
      expect(second.remember[0]).toContain("gate next e8 --full");

      // Which gives the whole brief back, for a node with no subagent left.
      const full = await next(ctx, "e8", { full: true });
      expect(full.do).toBe("delegate");
      if (full.do !== "delegate") return;
      expect(full.prompt).toContain("the long way round");
      expect(full.prompt).toContain("pass one");
      expect(full.remember[0]).not.toContain("--full");
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });

  /**
   * The type name is what the session can see — it is on the delegate
   * instruction, and it is the file gate wrote — so it is the value a session
   * reaches for, and sending to it resolves to nobody. Stored, it costs a
   * whole pass: the next one starts a fresh subagent that reads the worktree
   * again. Refused before the step is recorded, so the session can hand the
   * same answer back with the right id.
   */
  it("refuses the subagent's type name, records nothing, and keeps the id an earlier pass named", async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-claude-"));
    try {
      const server = fakeServer("e7", "twice");
      const ctx = context(server.client);
      syncSubagents("t", { root: join(home, "cache", "t"), teamId: "t" });

      const first = await next(ctx, "e7");
      expect(first.do).toBe("delegate");
      if (first.do !== "delegate") return;
      // Exactly the name the instruction just handed the session.
      expect(first.subagent).toBe("gate-t-builder");
      await step(ctx, "e7", "build", '{"summary": "pass one"}', { subagent: "agent-one" });
      expect(recallSubagent("e7", "build")).toBe("agent-one");

      await expect(step(ctx, "e7", "build", '{"summary": "pass two"}', { subagent: first.subagent })).rejects.toThrow(
        /agent id the Agent tool returned/,
      );
      // Nothing happened: the step was not recorded, and the resume target the
      // first pass named is still there to hand back with.
      expect(server.steps.filter((s) => s.nodeId === "build").length).toBe(1);
      expect(recallSubagent("e7", "build")).toBe("agent-one");

      // The same answer with the right id goes through.
      const done = await step(ctx, "e7", "build", '{"summary": "pass two"}', { subagent: "agent-two" });
      expect(done.do).toBe("done");
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  });
});
