import { spawn } from "node:child_process";

import type { AgentDefinition } from "@/agents/types";
import { WorkflowError } from "@/runtime/errors";
import type { NodeUsageRecord, ToolCallRecord } from "@/runtime/state";
import type { RunWorkspace } from "@/runtime/workspace";

import { parseOutput } from "./agent";

/**
 * Runs one agent node by handing it to a headless Claude Code in the worktree,
 * instead of gate holding the conversation itself.
 *
 * Why it exists: gate's own loop appends every tool result to one message list
 * and never trims it, so a node that reads its way through a large repository
 * ends up re-sending a six-figure context every round — a planner observed here
 * spent $7 and 9M tokens without answering, most of it re-reading itself.
 * Claude Code compacts, which is the thing no round cap can substitute for: a
 * cap kills the node, compaction lets it finish cheaply. Its tools are also the
 * better ones — real ripgrep, ranged reads, an edit that verifies uniqueness —
 * where gate's own truncate at 100 matches and 200KB.
 *
 * What does not change: the child is pointed at this gate's own gateway, so
 * every call it makes is routed, metered and counted against the run's budget
 * exactly like a call gate made itself. The engine still owns the graph; only
 * the loop inside one node moves.
 */

/** Where the child sends its API calls. Gate's own gateway, so routing still applies. */
function gatewayUrl(): string {
  if (process.env.GATE_SELF_URL) return `${process.env.GATE_SELF_URL.replace(/\/$/, "")}/api/gateway`;
  return `http://127.0.0.1:${process.env.PORT ?? 4141}/api/gateway`;
}

export interface ClaudeCodeDeps {
  workspace: RunWorkspace | null;
  onToolCall?: (call: ToolCallRecord) => void;
  signal?: AbortSignal;
  /** Injectable so tests do not spawn a real CLI. */
  spawnCli?: typeof spawn;
}

/** The subset of `--output-format json` gate actually reads. */
interface CliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export async function runClaudeCodeNode(
  agent: AgentDefinition,
  prompt: string,
  nodeId: string,
  deps: ClaudeCodeDeps,
  deadline: number | null,
): Promise<{ output: unknown; usage: NodeUsageRecord; toolCalls: ToolCallRecord[] }> {
  if (!deps.workspace) {
    throw new WorkflowError(
      "AGENT_DEFINITION_INVALID",
      `node "${nodeId}": agent "${agent.id}" uses the claude-code executor, which needs a workspace; declare one on the workflow`,
      { nodeId, agentId: agent.id },
    );
  }

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    agent.model,
    // The worktree is the whole world for this node; nothing above it is readable.
    "--add-dir",
    deps.workspace.root,
    // A run is unattended: a prompt nobody can answer is a hang, not a question.
    //
    // This is the `--dangerously-skip-permissions` setting, and it is wider than
    // it needs to be for edits alone — Bash is unconfined, so a node is only as
    // bounded as the machine gate runs on, not as the worktree it works in. It
    // is here because an implementer that must run the project's own toolchain
    // cannot be enumerated in advance, and a denied call in an unattended run
    // reads as a mysterious failure an hour later.
    "--permission-mode",
    "bypassPermissions",
    // Gate's own plugin would let a node start another run from inside a run.
    "--disallowed-tools",
    "Bash(gate-workflow*)",
  ];
  if (agent.tools.length) args.push("--allowed-tools", ...agent.tools);
  if (agent.effort) args.push("--effort", agent.effort);
  // The node contract — "answer with exactly this JSON" — is gate's, not the
  // harness's, so it rides as an appended system prompt rather than the user turn.
  if (agent.output.type === "json") {
    const fields = Object.entries(agent.output.schema)
      .map(([field, type]) => `  "${field}": ${type}`)
      .join("\n");
    args.push(
      "--append-system-prompt",
      `When you have finished the work, your final message must be a single JSON object and nothing else — no prose, no code fence. Fields:\n{\n${fields}\n}\nA type ending in "?" is optional.`,
    );
  }

  const spawnCli = deps.spawnCli ?? spawn;
  const child = spawnCli("claude", args, {
    cwd: deps.workspace.root,
    env: { ...process.env, ANTHROPIC_BASE_URL: gatewayUrl() },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

  const settled = await new Promise<{ code: number | null; timedOut: boolean; cancelled: boolean }>((resolve) => {
    let done = false;
    const finish = (r: { code: number | null; timedOut: boolean; cancelled: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const timer =
      deadline === null
        ? undefined
        : setTimeout(
            () => {
              child.kill("SIGKILL");
              finish({ code: null, timedOut: true, cancelled: false });
            },
            Math.max(0, deadline - Date.now()),
          );
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ code: null, timedOut: false, cancelled: true });
    };
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish({ code: null, timedOut: false, cancelled: false }));
    child.on("close", (code) => finish({ code, timedOut: false, cancelled: false }));
  });

  if (settled.cancelled) {
    throw new WorkflowError("RUN_CANCELLED", `node "${nodeId}" was cancelled`, { nodeId });
  }
  if (settled.timedOut) {
    throw new WorkflowError("NODE_TIMEOUT", `node "${nodeId}" exceeded its timeout`, { nodeId });
  }

  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout.trim()) as CliResult;
  } catch {
    const detail = (stderr.trim() || stdout.trim() || "no output").slice(0, 500);
    throw new WorkflowError(
      "MODEL_EXECUTION_ERROR",
      `node "${nodeId}": claude-code exited ${settled.code ?? "without a code"} and produced no result JSON — ${detail}`,
      { nodeId, agentId: agent.id },
    );
  }

  const usage: NodeUsageRecord = {
    model: modelOf(parsed) ?? agent.model,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
  };
  // Every call the child made already went through gate's gateway, so the tool
  // rounds it took are the honest per-node figure to report here.
  const toolCalls: ToolCallRecord[] = [];

  if (parsed.is_error || typeof parsed.result !== "string") {
    throw new WorkflowError(
      "MODEL_EXECUTION_ERROR",
      `node "${nodeId}": claude-code did not finish (${parsed.subtype ?? "unknown"})${
        parsed.permission_denials?.length ? `, ${parsed.permission_denials.length} tool call(s) denied` : ""
      }`,
      { nodeId, agentId: agent.id, usage },
    );
  }

  return { output: parseOutput(agent, parsed.result, nodeId), usage, toolCalls };
}

/** The concrete model the gateway routed to, when the child reported one. */
function modelOf(r: CliResult): string | null {
  const keys = r.modelUsage ? Object.keys(r.modelUsage) : [];
  return keys.length ? keys[0] : null;
}
