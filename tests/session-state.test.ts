import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GateClient } from "@/client/api";
import { next, noteSession, sessionStatePath, step, type SessionRunContext } from "@/client/step";
import type { ExecutionStepRecord } from "@/executions/types";

/**
 * What a session is told, and what is written down about it.
 *
 * A person driving several runs from several terminals needs something that
 * says which one is waiting on them, and whether it wants an answer or a yes.
 * The instruction carries it (`asks`), and every instruction is also written
 * against the Claude Code session it went to, so a cockpit or a hook on the
 * same machine can read it without a network call.
 */

const previousHome = process.env.GATE_HOME;
const previousSession = process.env.GATE_CLAUDE_SESSION;
let home: string;

function agent(id: string, asks: string): string {
  return `---
name: ${id}
executor: gate
asks: ${asks}
output:
  type: json
  schema:
    answer: string
---
Ask about {{input.task}}.
`;
}

function workflow(id: string, agentId: string): string {
  return `name: ${id}
entry: ask
nodes:
  - id: ask
    type: agent
    agent: ${agentId}
    next: done
  - id: done
    type: terminal
    status: completed
`;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-session-state-"));
  process.env.GATE_HOME = home;
  process.env.GATE_CLAUDE_SESSION = "sess-abc-123";
  const cache = join(home, "cache", "t");
  mkdirSync(join(cache, "agents"), { recursive: true });
  mkdirSync(join(cache, "workflows"), { recursive: true });
  writeFileSync(join(cache, "agents", "approve.md"), agent("approve", "approval"));
  writeFileSync(join(cache, "agents", "clarify.md"), agent("clarify", "question"));
  writeFileSync(join(cache, "agents", "legacy.md"), agent("legacy", "person"));
  writeFileSync(join(cache, "workflows", "w-approve.yaml"), workflow("w-approve", "approve"));
  writeFileSync(join(cache, "workflows", "w-clarify.yaml"), workflow("w-clarify", "clarify"));
  writeFileSync(join(cache, "workflows", "w-legacy.yaml"), workflow("w-legacy", "legacy"));
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.GATE_HOME;
  else process.env.GATE_HOME = previousHome;
  if (previousSession === undefined) delete process.env.GATE_CLAUDE_SESSION;
  else process.env.GATE_CLAUDE_SESSION = previousSession;
});

function fakeServer(executionId: string, workflowId: string) {
  const steps: ExecutionStepRecord[] = [];
  const client = {
    async execution() {
      return {
        execution: { id: executionId, workflowId, status: "running", error: null, input: { task: "a thing" }, workspace: null },
        steps: [...steps],
      };
    },
    async report(_id: string, payload: { steps: ExecutionStepRecord[] }) {
      for (const s of payload.steps) steps.push({ ...s, executionId } as ExecutionStepRecord);
      return { cancelRequested: false };
    },
    async finish() {},
  } as unknown as GateClient;
  return client;
}

function context(client: GateClient): SessionRunContext {
  return { client, team: "t", say: () => {} };
}

describe("the kind of turn a person's node is", () => {
  it("is carried on the instruction: approval, question, and the older spelling as a question", async () => {
    const approval = await next(context(fakeServer("s1", "w-approve")), "s1");
    expect(approval).toMatchObject({ do: "agent", nodeId: "ask", asks: "approval" });
    const question = await next(context(fakeServer("s2", "w-clarify")), "s2");
    expect(question).toMatchObject({ do: "agent", asks: "question" });
    const legacy = await next(context(fakeServer("s3", "w-legacy")), "s3");
    expect(legacy).toMatchObject({ do: "agent", asks: "question" });
  });
});

describe("the session's state file", () => {
  it("records each instruction against the session, and that the run is over", async () => {
    const client = fakeServer("s4", "w-approve");
    const ctx = context(client);

    const handed = await next(ctx, "s4");
    const written = noteSession(handed, 1_000);
    const file = sessionStatePath("sess-abc-123");
    expect(file).toBe(join(home, "sessions", "sess-abc-123.json"));
    expect(written).toMatchObject({ session: "sess-abc-123", executionId: "s4", state: "agent", nodeId: "ask", agent: "approve", asks: "approval", at: 1_000 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(written);

    const after = await step(ctx, "s4", "ask", '{"answer": "go ahead"}');
    expect(after.do).toBe("done");
    noteSession(after, 2_000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ executionId: "s4", state: "done", nodeId: null, asks: null, at: 2_000 });
  });

  it("writes nothing when no session is known", async () => {
    // Both spellings: the plugin's hook, and the one Claude Code itself puts
    // in a tool's environment — which is set when these tests run inside it.
    const saved = { hook: process.env.GATE_CLAUDE_SESSION, own: process.env.CLAUDE_CODE_SESSION_ID };
    delete process.env.GATE_CLAUDE_SESSION;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      const handed = await next(context(fakeServer("s5", "w-clarify")), "s5");
      expect(noteSession(handed)).toBeNull();
      expect(existsSync(join(home, "sessions", "undefined.json"))).toBe(false);
    } finally {
      process.env.GATE_CLAUDE_SESSION = saved.hook;
      if (saved.own !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved.own;
    }
  });
});
