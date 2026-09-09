import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseAgent } from "@/agents/loader";
import { providerModelEnv, runClaudeCodeNode } from "@/runtime/executors/claude-code";

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };
// A real directory: the executor refuses to spawn into a worktree that is not
// there, which is the point of one of the tests below.
const root = mkdtempSync(join(tmpdir(), "gate-cc-"));
const workspace = { root, repo: root, branch: "b", baseRef: "HEAD" };

const AGENT = `---
name: Builder
model: sonnet
executor: claude-code
tools: [Read, Grep, Edit]
output:
  type: json
  schema:
    summary: string
---
Do the work.
`;

/** A stand-in for the CLI: replays one canned stdout, then exits. */
function fakeCli(stdout: string | string[], code = 0, stderr = "") {
  return ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = Readable.from(Array.isArray(stdout) ? stdout : [stdout]);
    child.stderr = Readable.from([stderr]);
    child.kill = () => true;
    (fakeCli as unknown as { lastArgs: string[] }).lastArgs = args;
    setTimeout(() => child.emit("close", code), 0);
    return child;
  }) as never;
}

/** An NDJSON stream shaped like the real `--output-format stream-json`. */
const STREAM = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "text", text: "Looking for the flag." }, { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "isOnline" } }] } },
  { type: "user", message: { content: [{ tool_use_id: "t1", type: "tool_result", content: "ts/a.ts:12" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "ts/a.ts" } }] } },
  { type: "user", message: { content: [{ tool_use_id: "t2", type: "tool_result", content: "denied", is_error: true }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"summary": "did the thing"}',
    usage: { input_tokens: 6, output_tokens: 408, cache_read_input_tokens: 98115 },
    modelUsage: { "claude-sonnet-5": {} },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

const OK = STREAM;

/** A minimal stream whose result line carries `payload` as the agent's answer. */
function streamOf(payload: unknown, sessionId: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: JSON.stringify(payload),
    usage: { input_tokens: 6, output_tokens: 408, cache_read_input_tokens: 0 },
    modelUsage: { "claude-sonnet-5": {} },
  });
}

describe("claude-code executor", () => {
  it("validates the CLI's final message against the agent's declared output shape", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    const res = await runClaudeCodeNode(agent, "go", "build", { workspace, spawnCli: fakeCli(OK) }, null);

    expect(res.output).toEqual({ summary: "did the thing" });
    // Usage is read off the CLI so a claude-code node counts against maxCostUsd
    // exactly like a gate-loop node does — that is what keeps the budget honest.
    expect(res.usage).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 6,
      outputTokens: 408,
      cacheReadTokens: 98115,
    });
  });

  it("points the child at gate's own gateway and passes the declared tools", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    await runClaudeCodeNode(agent, "go", "build", { workspace, spawnCli: fakeCli(OK) }, null);
    const args = (fakeCli as unknown as { lastArgs: string[] }).lastArgs;

    // Streamed, not one blob at the end: the dashboard has to fill in while the
    // node runs, not after it.
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // Unattended: a permission prompt nobody can answer is a hang, not a question.
    // Unattended, and running as root as a service — where Claude Code refuses
    // bypassPermissions outright. `auto` decides without asking; the prompt
    // target denies whatever is left rather than waiting for nobody.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    // Full toolset on purpose — --allowed-tools gates prompts, not capability.
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--disallowed-tools");
    // Told it is unattended, whatever its skills expect: a skill that stops for
    // approval would otherwise wait on a question that reaches nobody — or,
    // worse, decide for itself that nobody is there when somebody is.
    const appended = args[args.indexOf("--append-system-prompt") + 1];
    expect(appended).toContain("running unattended");
    // But not told to decide for the person: where the prompt gives questions
    // a way out (the planner's `questions`), they go there, and the node stops.
    expect(appended).toContain("the person decides, not you");
  });

  it("reports each tool call as it comes back, so the run is watchable", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    const seen: string[] = [];
    const said: string[] = [];
    const res = await runClaudeCodeNode(
      agent,
      "go",
      "build",
      { workspace, spawnCli: fakeCli(STREAM), onToolCall: (c) => seen.push(`${c.tool}:${c.ok}`), onText: (t) => said.push(t) },
      null,
    );

    // Emitted live during the node, not assembled at the end.
    expect(seen).toEqual(["Grep:true", "Edit:false"]);
    // What the child said on the way is passed on too: the person follows the node by it.
    expect(said).toEqual(["Looking for the flag."]);
    // And recorded on the step, so the finished run keeps its evidence.
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]).toMatchObject({ tool: "Grep", input: { pattern: "isOnline" }, ok: true, result: "ts/a.ts:12" });
    expect(res.toolCalls[1]).toMatchObject({ tool: "Edit", ok: false, result: "denied" });
  });

  it("survives a stream that arrives split mid-line", async () => {
    // Chunk boundaries fall wherever the pipe puts them; a half-written JSON
    // line must not lose the tool call it was carrying.
    const agent = parseAgent("builder", AGENT, meta);
    const half = Math.floor(STREAM.length / 2);
    const res = await runClaudeCodeNode(
      agent,
      "go",
      "build",
      { workspace, spawnCli: fakeCli([STREAM.slice(0, half), STREAM.slice(half)]) },
      null,
    );
    expect(res.toolCalls).toHaveLength(2);
    expect(res.output).toEqual({ summary: "did the thing" });
  });

  it("resumes the session to fix a malformed answer instead of failing the node", async () => {
    // The expensive half is already done when the packaging is wrong. Killing
    // the node there throws the work away and, on a parallel branch, takes the
    // whole run with it — a review that never reaches the verdict is a
    // rejection that never reaches the planner.
    const badThenGood = [
      streamOf({ summary: { text: "an object where a string was declared" } }, "sess-1"),
      streamOf({ summary: "did the thing" }, "sess-1"),
    ];
    const spawns: string[][] = [];
    const cli = ((_cmd: string, args: string[]) => {
      spawns.push(args);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = Readable.from([badThenGood[spawns.length - 1] ?? badThenGood[1]]);
      child.stderr = Readable.from([""]);
      child.kill = () => true;
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    }) as never;

    const agent = parseAgent("builder", AGENT, meta);
    const res = await runClaudeCodeNode(agent, "go", "build", { workspace, spawnCli: cli }, null);

    expect(res.output).toEqual({ summary: "did the thing" });
    expect(spawns).toHaveLength(2);
    // Resumed, not re-run: the second turn continues the same session and is
    // told what was wrong rather than being handed the whole job again.
    expect(spawns[1][spawns[1].indexOf("--resume") + 1]).toBe("sess-1");
    expect(spawns[1][spawns[1].indexOf("-p") + 1]).toMatch(/did not match the output shape/);
    // Both turns are paid for, so the budget sees the correction.
    expect(res.usage.outputTokens).toBe(816);
  });

  it("gives up after the retries rather than looping on a shape it cannot produce", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    const spawns: string[][] = [];
    const cli = ((_cmd: string, args: string[]) => {
      spawns.push(args);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = Readable.from([streamOf({ summary: { still: "wrong" } }, "sess-1")]);
      child.stderr = Readable.from([""]);
      child.kill = () => true;
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    }) as never;

    await expect(runClaudeCodeNode(agent, "go", "build", { workspace, spawnCli: cli }, null)).rejects.toMatchObject({
      code: "AGENT_OUTPUT_VALIDATION_ERROR",
    });
    expect(spawns).toHaveLength(3); // the first turn plus two corrections
  });

  it("names the missing worktree instead of spawning into nothing", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    const gone = { root: "/tmp/gate-worktree-that-is-not-there", repo: "x", branch: "b", baseRef: "HEAD" };
    let spawned = false;
    const cli = (() => {
      spawned = true;
      throw new Error("should not reach the CLI");
    }) as never;

    await expect(runClaudeCodeNode(agent, "go", "build", { workspace: gone, spawnCli: cli }, null)).rejects.toMatchObject({
      code: "WORKSPACE_ERROR",
      message: expect.stringContaining(gone.root),
    });
    expect(spawned).toBe(false);
  });

  it("refuses the executor when the workflow declares no workspace", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    await expect(
      runClaudeCodeNode(agent, "go", "build", { workspace: null, spawnCli: fakeCli(OK) }, null),
    ).rejects.toMatchObject({ code: "AGENT_DEFINITION_INVALID" });
  });

  it("reports the CLI's own failure rather than a parse error", async () => {
    const agent = parseAgent("builder", AGENT, meta);
    await expect(
      runClaudeCodeNode(agent, "go", "build", { workspace, spawnCli: fakeCli("", 1, "not logged in") }, null),
    ).rejects.toMatchObject({ code: "MODEL_EXECUTION_ERROR", message: expect.stringContaining("not logged in") });
  });
});

describe("a node running on a provider model", () => {
  it("pins every alias the child could ask for to that same model", () => {
    const env = providerModelEnv("provider:zai/glm-5.3");
    // Claude Code asks for `haiku` on its own for background work; unpinned,
    // gate would resolve that alias onto a Claude tier and the node would
    // need a connected Claude account it has no reason to need.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("provider:zai/glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("provider:zai/glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("provider:zai/glm-5.3");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("leaves a Claude model to the router's own ladder", () => {
    expect(providerModelEnv("sonnet")).toEqual({});
    expect(providerModelEnv("claude-sonnet-5")).toEqual({});
  });

  it("hands the pins to the spawned child, alongside the gateway it reports to", async () => {
    let seen: Record<string, string> | undefined;
    type Spawn = (cmd: string, args: string[], opts: { env: Record<string, string> }) => unknown;
    const inner = fakeCli(STREAM) as unknown as Spawn;
    const spawnCli = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      seen = opts.env;
      return inner(cmd, args, opts);
    }) as never;
    const agent = parseAgent("builder", AGENT.replace("model: sonnet", "model: provider:zai/glm-5.3"), meta);
    await runClaudeCodeNode(agent, "go", "n1", { workspace, spawnCli, gatewayUrl: "http://gate/api/gateway" }, null);
    expect(seen!.ANTHROPIC_BASE_URL).toBe("http://gate/api/gateway");
    expect(seen!.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("provider:zai/glm-5.3");
  });
});
