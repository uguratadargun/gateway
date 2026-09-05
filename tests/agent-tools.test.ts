import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { parseAgent, AgentDefinitionError } from "@/agents/loader";
import type { AgentDefinition } from "@/agents/types";
import type { WorkflowEvent } from "@/events/types";
import { runWorkflow } from "@/runtime/engine";
import { createRunWorkspace, removeRunWorkspace, summarizeWorkspace, type RunWorkspace } from "@/runtime/workspace";
import { parseWorkflow } from "@/workflows/loader";

import { FakeModelProvider, toolUse } from "./fakes/fake-model-provider";

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };

const BUILDER = `---
name: Builder
model: sonnet
tools: [read_file, write_file, run_command]
output:
  type: json
  schema:
    summary: string
---
Do the work.
`;

const loadAgent = (id: string): AgentDefinition => parseAgent(id, BUILDER, meta);

const WORKFLOW = `
name: Tool run
entry: build
nodes:
  - id: build
    type: agent
    agent: builder
    next: done
  - id: done
    type: terminal
`;

let root: string;
let workspace: RunWorkspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-agent-ws-"));
  workspace = { root, repo: root, branch: "gate/run-test", baseRef: "HEAD" };
});

describe("agent tool loop", () => {
  it("runs the tools the model asks for, then validates its final answer", async () => {
    const provider = new FakeModelProvider((_req, i) => {
      if (i === 0) return { toolUses: [toolUse("write_file", { path: "out.txt", content: "hello" })] };
      if (i === 1) return { toolUses: [toolUse("read_file", { path: "out.txt" }, "tu_read")] };
      return JSON.stringify({ summary: "wrote and verified out.txt" });
    });

    const events: WorkflowEvent[] = [];
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), {
      provider,
      loadAgent,
      workspace,
      emit: (e) => events.push(e),
    });

    expect(state.status).toBe("completed");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hello");
    expect(state.outputs.build).toEqual({ summary: "wrote and verified out.txt" });

    const step = state.history[0];
    expect(step.toolCalls?.map((c) => c.tool)).toEqual(["write_file", "read_file"]);
    expect(step.toolCalls?.every((c) => c.ok)).toBe(true);
    expect(events.filter((e) => e.type === "tool.called").map((e) => e.tool)).toEqual(["write_file", "read_file"]);

    // The model is handed its own tool calls back, then their results.
    const second = provider.calls[1];
    expect(second.messages[1]).toMatchObject({ role: "assistant" });
    expect(second.messages[2].content).toMatchObject([{ type: "tool_result", toolUseId: "tu_write_file", isError: false }]);
    // Usage is summed across the whole loop, not just the last call.
    expect(provider.calls).toHaveLength(3);
  });

  it("hands a tool failure back to the model instead of failing the node", async () => {
    const provider = new FakeModelProvider((_req, i) => {
      if (i === 0) return { toolUses: [toolUse("read_file", { path: "../../etc/passwd" })] };
      return JSON.stringify({ summary: "recovered" });
    });

    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), { provider, loadAgent, workspace });

    expect(state.status).toBe("completed");
    expect(state.history[0].toolCalls?.[0]).toMatchObject({ ok: false });
    expect(String(provider.calls[1].messages[2].content)).not.toBe("");
    const results = provider.calls[1].messages[2].content as Array<{ isError?: boolean; content: string }>;
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toMatch(/outside the workspace/);
  });

  it("stops an agent that never stops calling tools, keeping what it spent", async () => {
    const provider = new FakeModelProvider(() => ({
      toolUses: [toolUse("read_file", { path: "out.txt" })],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    }));
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), {
      provider,
      loadAgent,
      workspace,
      maxToolIterations: 3,
    });
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("TOOL_LIMIT_EXCEEDED");

    // The step failed with nothing to show for it before this: every tool
    // round it actually made, and every token it actually spent, used to be
    // thrown away along with the error that reported them.
    const step = state.history.at(-1)!;
    expect(step.status).toBe("failed");
    expect(step.toolCalls).toHaveLength(3);
    expect(step.toolCalls?.every((c) => c.tool === "read_file")).toBe(true);
    // 4 model calls happen before the 4th trips the limit (iterations 0-3);
    // only the first 3 got as far as making a tool call.
    expect(step.usage).toMatchObject({ inputTokens: 40, outputTokens: 20 });
  });

  it("lets an agent's own maxToolIterations override the run's default", async () => {
    const capped = `---
name: Builder
model: sonnet
tools: [read_file, write_file, run_command]
maxToolIterations: 2
output:
  type: json
  schema:
    summary: string
---
Do the work.
`;
    const provider = new FakeModelProvider(() => ({
      toolUses: [toolUse("read_file", { path: "out.txt" })],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    }));
    // No maxToolIterations passed to the run at all — a long task's agent
    // needing more rounds than the default (or fewer, as here) sets it on
    // itself rather than the workflow having to raise it for every node.
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), {
      provider,
      loadAgent: (id) => parseAgent(id, capped, meta),
      workspace,
    });
    expect(state.error?.code).toBe("TOOL_LIMIT_EXCEEDED");
    expect(state.history.at(-1)!.toolCalls).toHaveLength(2);
  });

  it("offers no tools when the workflow has no workspace", async () => {
    const provider = new FakeModelProvider(() => JSON.stringify({ summary: "prose only" }));
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), { provider, loadAgent });
    expect(state.status).toBe("completed");
    expect(provider.calls[0].tools).toBeUndefined();
  });

  it("rejects an agent file that declares a tool that does not exist", () => {
    expect(() => parseAgent("a", BUILDER.replace("run_command", "rm_rf"), meta)).toThrow(AgentDefinitionError);
    expect(() => parseAgent("a", BUILDER.replace("run_command", "rm_rf"), meta)).toThrow(/unknown tool/);
  });
});

describe("run workspace", () => {
  it("gives each run its own worktree and branch, leaving the repo untouched", () => {
    const repo = mkdtempSync(join(tmpdir(), "gate-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("commit", "-m", "init");

    const home = process.env.GATE_HOME;
    process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-home-"));
    try {
      const ws = createRunWorkspace({ repo }, "abcdef12-3456-7890-abcd-ef1234567890");
      expect(existsSync(join(ws.root, "README.md"))).toBe(true);
      expect(ws.branch).toBe("gate/run-abcdef12");

      writeFileSync(join(ws.root, "new.txt"), "from the run\n");
      const summary = summarizeWorkspace(ws);
      expect(summary.changedFiles.some((f) => f.includes("new.txt"))).toBe(true);
      // The user's checkout never sees the run's files.
      expect(existsSync(join(repo, "new.txt"))).toBe(false);
      expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");

      removeRunWorkspace(ws);
      expect(existsSync(ws.root)).toBe(false);
    } finally {
      process.env.GATE_HOME = home;
    }
  });

  it("refuses a path that is not a git repository", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "gate-notrepo-"));
    expect(() => createRunWorkspace({ repo: notRepo }, "exec")).toThrow(/not a git repository/);
    expect(() => createRunWorkspace({ repo: "/nope/nowhere" }, "exec")).toThrow(/does not exist/);
  });
});
