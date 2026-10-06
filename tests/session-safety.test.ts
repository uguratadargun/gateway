import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GateApiError, type GateClient } from "@/client/api";
import { listWorkspaces, planClean } from "@/client/clean";
import { parseInputs } from "@/client/cli";
import {
  continueRun,
  next,
  pinDefinitions,
  rememberSubagent,
  runDir,
  step,
  type Instruction,
  type SessionRunContext,
} from "@/client/step";
import { syncSubagents } from "@/client/subagents";
import { cacheScope } from "@/client/cache";
import type { ExecutionStepRecord } from "@/executions/types";
import { checkpointWork, publishBranch, DEFAULT_BRANCH_POLICY } from "@/repos/publish";
import { borrowedLinksToExclude } from "@/runtime/workspace";

/**
 * What a session-driven run must not do, whatever state it is found in.
 *
 * Each case here is one the walk used to get wrong: a count every agent read
 * as zero, a run with no worktree that went on in the person's checkout, an
 * outcome the gate never heard followed by the worktree going anyway, an edge
 * or an input that wedged the run instead of failing it, two commands running
 * the same node, a pause the gate never heard of, and the smaller slips in
 * publishing, cleaning and reading `--input`.
 */

const previousHome = process.env.GATE_HOME;
const previousClaude = process.env.CLAUDE_CONFIG_DIR;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const GATE_AGENT = (name: string, schema: string, body: string, extra = "") => `---
name: ${name}
executor: gate
${extra}output:
  type: json
  schema:
${schema}
---
${body}
`;

function mirror(files: Record<string, string>): void {
  const cache = join(home, "cache", "t");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(cache, path, ".."), { recursive: true });
    writeFileSync(join(cache, path), body);
  }
}

interface FakeOptions {
  workflowId: string;
  input?: Record<string, unknown>;
  workspace?: unknown;
  status?: string;
  error?: { code: string; message: string } | null;
}

/** The server, as the client sees it: steps, events and the outcome it was told. */
function fakeServer(executionId: string, opts: FakeOptions) {
  const steps: ExecutionStepRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const finished: Array<{ status: string; error: { code: string } | null }> = [];
  const state = {
    status: opts.status ?? "running",
    error: opts.error ?? null,
    reportFails: false,
    finishFails: false,
    continued: 0,
  };
  const client = {
    async execution() {
      return {
        execution: {
          id: executionId,
          workflowId: opts.workflowId,
          driver: "session",
          status: state.status,
          error: state.error,
          input: opts.input ?? { task: "a thing" },
          workspace: opts.workspace ?? null,
        },
        steps: [...steps],
        publish: null,
      };
    },
    async report(_id: string, payload: { events: Array<Record<string, unknown>>; steps: ExecutionStepRecord[] }) {
      if (state.reportFails) throw new GateApiError("cannot reach gate", 0, "UNREACHABLE");
      events.push(...payload.events);
      for (const s of payload.steps) steps.push({ ...s, executionId } as ExecutionStepRecord);
      return { cancelRequested: false };
    },
    async finish(_id: string, payload: { status: string; error: { code: string } | null }) {
      if (state.finishFails) throw new GateApiError("cannot reach gate", 0, "UNREACHABLE");
      finished.push(payload);
      state.status = payload.status;
    },
    async continueRun() {
      state.continued++;
      return { continued: true, retried: [] };
    },
  } as unknown as GateClient;
  return { client, steps, events, finished, state };
}

function context(client: GateClient): SessionRunContext & { said: string[] } {
  const said: string[] = [];
  return { client, team: "t", say: (m) => said.push(m), said };
}

const settled = (p: Promise<Instruction>) => p.then((i) => i, (e: Error) => ({ threw: e.message }));

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-safety-"));
  process.env.GATE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-safety-claude-"));
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
  process.env.CLAUDE_CONFIG_DIR = previousClaude;
});

describe("visits in a session run", () => {
  it("reach an agent's inputs and a command's argv with the real count", async () => {
    mirror({
      "agents/planner.md": GATE_AGENT("Planner", "    plan: string", "Plan {{input.task}}."),
      "agents/checker.md": GATE_AGENT(
        "Checker",
        "    ok: boolean",
        "The planner ran {{inputs.visits.planner}} times; this is check {{inputs.visits.check}}.",
        "inputs: [visits.planner, visits.check]\n",
      ),
      "workflows/visits.yaml": `name: V
entry: planner
nodes:
  - id: planner
    type: agent
    agent: planner
    next: note
  - id: note
    type: command
    command: [echo, "pass {{visits.planner}}"]
    edges:
      - when: visits.planner >= 2
        to: check
      - to: planner
  - id: check
    type: agent
    agent: checker
    next: done
  - id: done
    type: terminal
    status: completed
`,
    });
    const server = fakeServer("v1", { workflowId: "visits" });
    const ctx = context(server.client);
    expect((await next(ctx, "v1")).do).toBe("agent");
    expect((await step(ctx, "v1", "planner", '{"plan":"a"}')).do).toBe("agent");
    const atCheck = await step(ctx, "v1", "planner", '{"plan":"b"}');
    // The command saw the count as the walk had it, each time round.
    const notes = server.steps.filter((s) => s.nodeId === "note").map((s) => (s.output as { stdout: string }).stdout.trim());
    expect(notes).toEqual(["pass 1", "pass 2"]);
    expect(atCheck.do).toBe("agent");
    if (atCheck.do !== "agent") return;
    // What the conflict review is built on: the planner's pass, not zero —
    // and the node's own pass counted, 1 on its first.
    expect(atCheck.prompt).toContain("The planner ran 2 times; this is check 1.");
  });
});

describe("a run with no worktree", () => {
  const WORKFLOW = `name: WS
entry: touch
workspace: {}
nodes:
  - id: touch
    type: command
    command: ["true"]
    next: done
  - id: done
    type: terminal
    status: completed
`;

  it("is not walked on after it failed, and is not continued", async () => {
    mirror({ "workflows/ws.yaml": WORKFLOW });
    const server = fakeServer("ws1", {
      workflowId: "ws",
      status: "failed",
      error: { code: "WORKSPACE_ERROR", message: "a branch named gate/run-ws1 already exists" },
    });
    const ctx = context(server.client);
    const out = await next(ctx, "ws1");
    expect(out.do).toBe("failed");
    // Nothing ran: before, the command node ran in whatever directory this was typed in.
    expect(server.steps).toEqual([]);
    const cont = await settled(continueRun(ctx, "ws1"));
    expect(cont).toMatchObject({ threw: expect.stringContaining("before its worktree was made") });
    expect(server.state.continued).toBe(0);
  });

  it("fails a running run that has none, rather than run it in the person's checkout", async () => {
    const server = fakeServer("ws2", { workflowId: "ws" });
    const ctx = context(server.client);
    const out = await next(ctx, "ws2");
    expect(out).toMatchObject({ do: "failed", error: { code: "WORKSPACE_ERROR" } });
    expect(server.steps).toEqual([]);
    expect(server.finished).toMatchObject([{ status: "failed", error: { code: "WORKSPACE_ERROR" } }]);
  });
});

describe("a run's end the gate did not hear", () => {
  it("keeps the run's definitions, and settles when asked again", async () => {
    mirror({
      "workflows/short.yaml": `name: S
entry: say
nodes:
  - id: say
    type: command
    command: ["true"]
    next: done
  - id: done
    type: terminal
    status: completed
`,
    });
    pinDefinitions("t", "f1");
    const server = fakeServer("f1", { workflowId: "short" });
    server.state.finishFails = true;
    const ctx = context(server.client);
    const first = await settled(next(ctx, "f1"));
    expect(first).toMatchObject({ threw: expect.stringContaining("could not report the run's outcome") });
    // Before: told "done", with the pin already gone.
    expect(existsSync(join(runDir("f1"), "definitions"))).toBe(true);
    server.state.finishFails = false;
    const again = await next(ctx, "f1");
    expect(again).toMatchObject({ do: "done", status: "completed" });
    expect(server.finished).toHaveLength(1);
    expect(server.steps.map((s) => s.nodeId)).toEqual(["say"]);
    expect(existsSync(runDir("f1"))).toBe(false);
  });
});

describe("a run whose walk cannot go on", () => {
  it("fails on an edge that cannot be evaluated, instead of wedging", async () => {
    mirror({
      "agents/scorer.md": GATE_AGENT("Scorer", '    score: "number?"', "Score it."),
      "workflows/score.yaml": `name: Score
entry: score
nodes:
  - id: score
    type: agent
    agent: scorer
    edges:
      - when: outputs.score.score > 3
        to: good
      - to: bad
  - id: good
    type: terminal
    status: completed
  - id: bad
    type: terminal
    status: failed
`,
    });
    const server = fakeServer("r1", { workflowId: "score" });
    const ctx = context(server.client);
    await next(ctx, "r1");
    const out = await step(ctx, "r1", "score", "{}");
    expect(out).toMatchObject({ do: "failed", error: { code: "WORKFLOW_ROUTING_ERROR" } });
    expect(server.state.status).toBe("failed");
    // Asked again, it says the same and runs nothing.
    expect((await next(ctx, "r1")).do).toBe("failed");
  });

  it("records an input nobody produced as the node's failed step", async () => {
    mirror({
      "agents/first.md": GATE_AGENT("First", '    note: "string?"', "First."),
      "agents/second.md": GATE_AGENT("Second", "    ok: boolean", "{{inputs.first.note}}", "inputs: [first.note]\n"),
      "workflows/inputs.yaml": `name: I
entry: first
nodes:
  - id: first
    type: agent
    agent: first
    next: second
  - id: second
    type: agent
    agent: second
    next: done
  - id: done
    type: terminal
    status: completed
`,
    });
    const server = fakeServer("r2", { workflowId: "inputs" });
    const ctx = context(server.client);
    await next(ctx, "r2");
    const out = await step(ctx, "r2", "first", "{}");
    expect(out).toMatchObject({ do: "failed", nodeId: "second" });
    expect(server.steps.map((s) => `${s.nodeId}:${s.status}`)).toEqual(["first:completed", "second:failed"]);
    expect(server.state.status).toBe("failed");
  });
});

describe("an agent file that still names skills", () => {
  const ASKER = GATE_AGENT("Asker", "    answer: string", "Ask.", "asks: question\nskills: [try-it]\n");
  const WORKFLOW = `name: K
entry: ask
nodes:
  - id: ask
    type: agent
    agent: asker
    next: done
  - id: done
    type: terminal
    status: completed
`;

  it("runs, and the node is told nothing about them", async () => {
    mirror({ "agents/asker.md": ASKER, "workflows/skill.yaml": WORKFLOW });
    pinDefinitions("t", "k1");
    const server = fakeServer("k1", { workflowId: "skill" });
    const out = await next(context(server.client), "k1");
    expect(out.do).toBe("agent");
    if (out.do !== "agent") return;
    expect(out).not.toHaveProperty("skills");
    expect(out.remember.join("\n")).not.toContain("SKILL.md");
  });
});

describe("one gate command per run", () => {
  it("refuses a second while the first is working, and takes over a lock nobody holds", async () => {
    mirror({ "agents/planner.md": GATE_AGENT("Planner", "    plan: string", "Plan."), "workflows/lock.yaml": "name: L\nentry: planner\nnodes:\n  - id: planner\n    type: agent\n    agent: planner\n    next: done\n  - id: done\n    type: terminal\n    status: completed\n" });
    const server = fakeServer("l1", { workflowId: "lock" });
    const ctx = context(server.client);
    const lock = join(home, "runs", "l1.lock");
    mkdirSync(join(home, "runs"), { recursive: true });
    const holder = spawn("sleep", ["30"]);
    try {
      writeFileSync(lock, `${holder.pid}\n`);
      const refused = await settled(next(ctx, "l1"));
      expect(refused).toMatchObject({ threw: expect.stringContaining(`pid ${holder.pid}`) });
      expect(server.events).toEqual([]);
    } finally {
      holder.kill();
    }
    await new Promise((r) => holder.once("exit", r));
    // Its process is gone: the lock is stale and taken over.
    expect((await next(ctx, "l1")).do).toBe("agent");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("a person's turn the gate did not hear of", () => {
  it("is announced again on the next hand-out, and only until it arrives", async () => {
    mirror({
      "agents/asker2.md": GATE_AGENT("Asker", "    answer: string", "Ask.", "asks: question\n"),
      "workflows/pause.yaml": "name: P\nentry: ask\nnodes:\n  - id: ask\n    type: agent\n    agent: asker2\n    next: done\n  - id: done\n    type: terminal\n    status: completed\n",
    });
    const server = fakeServer("p1", { workflowId: "pause" });
    const ctx = context(server.client);
    server.state.reportFails = true;
    expect((await next(ctx, "p1")).do).toBe("agent");
    expect(server.events).toEqual([]);
    server.state.reportFails = false;
    await next(ctx, "p1");
    expect(server.events.map((e) => e.type)).toEqual(["node.started", "run.paused"]);
    await next(ctx, "p1");
    expect(server.events).toHaveLength(2);
  });
});

describe("a continued subagent", () => {
  it("is told which inputs were cleared, not only which were filled", async () => {
    mirror({
      "agents/impl.md": `---
name: Impl
executor: claude-code
inputs: [check.gaps?, review.notes?]
output:
  type: json
  schema:
    summary: string
---
Build it. Gaps: {{inputs.check.gaps}} Notes: {{inputs.review.notes}}
`,
      "agents/check.md": GATE_AGENT("Check", '    gaps: "string?"', "Check."),
      "agents/review.md": GATE_AGENT("Review", '    notes: "string?"', "Review."),
      "workflows/delta.yaml": `name: D
entry: impl
nodes:
  - id: impl
    type: agent
    agent: impl
    next: check
  - id: check
    type: agent
    agent: check
    edges:
      - when: visits.check >= 2
        to: review
      - to: impl
  - id: review
    type: agent
    agent: review
    edges:
      - when: visits.review >= 2
        to: done
      - to: impl
  - id: done
    type: terminal
    status: completed
`,
    });
    const server = fakeServer("d1", { workflowId: "delta" });
    const ctx = context(server.client);
    await next(ctx, "d1");
    rememberSubagent("d1", "impl", "agent-1");
    await step(ctx, "d1", "impl", '{"summary":"1"}');
    await step(ctx, "d1", "check", '{"gaps":"fix the parser"}');
    await step(ctx, "d1", "impl", '{"summary":"2"}');
    await step(ctx, "d1", "check", "{}");
    const third = await step(ctx, "d1", "review", '{"notes":"name it better"}');
    expect(third.do).toBe("delegate");
    if (third.do !== "delegate") return;
    expect(third.prompt).toContain("## review.notes\n\nname it better");
    expect(third.prompt).toContain("## check.gaps\n\n(cleared");
    expect(third.prompt).not.toContain("fix the parser");
  });
});

describe("publishing", () => {
  it("is not verified when the remote reads back another commit than the one pushed", () => {
    const repo = mkdtempSync(join(tmpdir(), "gate-safety-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "one");
    git(repo, "checkout", "-qb", "gate/run-x");
    const readFrom = mkdtempSync(join(tmpdir(), "gate-safety-read-"));
    const pushTo = mkdtempSync(join(tmpdir(), "gate-safety-push-"));
    git(readFrom, "init", "-q", "--bare");
    git(pushTo, "init", "-q", "--bare");
    git(repo, "remote", "add", "pub", readFrom);
    git(repo, "push", "-q", "pub", "HEAD:refs/heads/gate/run-x");
    // From here on pushes go elsewhere, and reads still come from the old place.
    git(repo, "remote", "set-url", "--push", "pub", pushTo);
    writeFileSync(join(repo, "a.txt"), "2\n");
    git(repo, "commit", "-qam", "two");
    const outcome = publishBranch(repo, "gate/run-x", { remote: "pub", branchPolicy: DEFAULT_BRANCH_POLICY });
    expect(outcome).toMatchObject({ ok: false, code: "not-verified" });
  });

  it("checkpoints a worktree whose repository already ignores the borrowed node_modules", () => {
    const repo = mkdtempSync(join(tmpdir(), "gate-safety-ckpt-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, ".gitignore"), "/node_modules\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    symlinkSync(mkdtempSync(join(tmpdir(), "gate-safety-deps-")), join(repo, "node_modules"));
    writeFileSync(join(repo, "work.txt"), "unfinished\n");
    // Handed every borrowed name, git refuses the ignored one and nothing is committed.
    expect(() => checkpointWork(repo, "wip", ["node_modules"])).toThrow();
    expect(borrowedLinksToExclude(repo)).toEqual([]);
    expect(checkpointWork(repo, "wip", borrowedLinksToExclude(repo))).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("gate clean", () => {
  it("keeps a worktree whose run the gate could not be asked about, even with --all", async () => {
    const root = join(home, "workspaces", "offline-run");
    mkdirSync(root, { recursive: true });
    const offline = {
      async execution() {
        throw new GateApiError("cannot reach gate", 0, "UNREACHABLE");
      },
    };
    const entries = await listWorkspaces(offline);
    const entry = entries.find((e) => e.executionId === "offline-run")!;
    expect(entry.status).toBe("unreachable");
    expect(planClean([entry], true).removed).toEqual([]);

    const gone = {
      async execution() {
        throw new GateApiError("execution not found", 404);
      },
    };
    const forgotten = (await listWorkspaces(gone)).find((e) => e.executionId === "offline-run")!;
    expect(forgotten.status).toBe("unknown");
    expect(planClean([forgotten], true).removed).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("--input", () => {
  it("takes a value with spaces in it, and still splits pairs given together", () => {
    expect(parseInputs({ input: "repo=/Users/x/My Projects/app" }, [])).toEqual({ repo: "/Users/x/My Projects/app" });
    expect(parseInputs({ input: "a=1 b=two words" }, [])).toEqual({ a: "1", b: "two words" });
    expect(parseInputs({ input: "a=1\u0000b=2" }, [])).toEqual({ a: "1", b: "2" });
  });
});

describe("subagent files", () => {
  it("stay for an agent a pinned run still uses after the team deleted it", () => {
    const agents = join(process.env.CLAUDE_CONFIG_DIR!, "agents");
    mirror({ "agents/retired.md": "---\nname: Retired\nexecutor: claude-code\n---\nDo it.\n" });
    syncSubagents("t", cacheScope("t"));
    expect(existsSync(join(agents, "gate-t-retired.md"))).toBe(true);
    pinDefinitions("t", "s1");
    rmSync(join(home, "cache", "t", "agents", "retired.md"));
    syncSubagents("t", cacheScope("t"));
    expect(readFileSync(join(agents, "gate-t-retired.md"), "utf8")).toContain("name: gate-t-retired");
    rmSync(runDir("s1"), { recursive: true, force: true });
    syncSubagents("t", cacheScope("t"));
    expect(existsSync(join(agents, "gate-t-retired.md"))).toBe(false);
  });
});
