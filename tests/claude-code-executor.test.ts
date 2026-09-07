import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseAgent } from "@/agents/loader";
import { runClaudeCodeNode } from "@/runtime/executors/claude-code";

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };
const workspace = { root: "/tmp/ws", repo: "/tmp/ws", branch: "b", baseRef: "HEAD" };

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
function fakeCli(stdout: string, code = 0, stderr = "") {
  return ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([stderr]);
    child.kill = () => true;
    (fakeCli as unknown as { lastArgs: string[] }).lastArgs = args;
    setTimeout(() => child.emit("close", code), 0);
    return child;
  }) as never;
}

const OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"summary": "did the thing"}',
  usage: { input_tokens: 6, output_tokens: 408, cache_read_input_tokens: 98115 },
  modelUsage: { "claude-sonnet-5": {} },
});

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

    expect(args).toContain("--allowed-tools");
    expect(args).toEqual(expect.arrayContaining(["Read", "Grep", "Edit"]));
    // Unattended: a permission prompt nobody can answer is a hang, not a question.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    // A node must not be able to start another run from inside a run.
    expect(args[args.indexOf("--disallowed-tools") + 1]).toBe("Bash(gate-workflow*)");
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
