import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { AgentDefinition } from "@/agents/types";
import { parseProviderRef } from "@/lib/providers";
import { WorkflowError } from "@/runtime/errors";
import type { NodeUsageRecord, ToolCallRecord } from "@/runtime/state";
import type { RunWorkspace } from "@/runtime/workspace";
import { buildSkillPlugin, skillsDirective, unattendedNotice } from "@/skills/inject";
import type { SkillDefinition } from "@/skills/types";

import { outputCorrection, parseOutput } from "./agent";

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

/**
 * Where the child sends its API calls. A gate gateway either way, so routing,
 * metering and the run's budget still apply — but which gate depends on who is
 * running the node. On the server it is this process; on a developer's machine
 * the client passes the company server's URL and that person's API key, which
 * is the whole of what makes a local run still a metered one.
 */
function gatewayUrl(override?: string): string {
  if (override) return `${override.replace(/\/$/, "")}`;
  if (process.env.GATE_SELF_URL)
    return `${process.env.GATE_SELF_URL.replace(/\/$/, "")}/api/gateway`;
  return `http://127.0.0.1:${process.env.PORT ?? 4141}/api/gateway`;
}

/**
 * Environment that points the child's *aliases* at the node's own model.
 *
 * Claude Code does not send only the model it was given. Its background work —
 * conversation titles, the small utility calls — asks for the `haiku` alias,
 * and gate resolves an alias by category, straight back onto a Claude tier.
 * A node running on a provider model would therefore still need a connected
 * Claude account to answer traffic the node never asked for, and a gate with
 * no Claude login at all would fail the node outright on a title.
 *
 * Pinning all three families to the node's own model settles it: every request
 * the child makes, asked for by alias or by id, lands on the model the agent
 * declared. This is the same mechanism Z.AI documents for pointing Claude Code
 * at GLM (`ANTHROPIC_DEFAULT_SONNET_MODEL` and friends) — the difference here
 * is only that the child is pointed at gate rather than at the vendor, so the
 * calls stay routed, metered and inside the run's budget.
 *
 * Returns nothing for a Claude model: the router's own ladder is the right
 * answer there, and pinning would disable it.
 */
export function providerModelEnv(model: string): Record<string, string> {
  if (!parseProviderRef(model)) return {};
  return {
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    // Telemetry and the other non-essential chatter would otherwise be served
    // by a model somebody is paying per token for, to no one's benefit.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Provider endpoints are routinely slower to first token than Anthropic's,
    // and the harness's own HTTP timeout is the one thing gate's node timeout
    // cannot rescue. Z.AI documents this same value for exactly this reason.
    API_TIMEOUT_MS: "3000000",
  };
}

export interface ClaudeCodeDeps {
  /**
   * The skills the agent declared, already resolved. They are handed to the
   * child as a plugin rather than pasted into its prompt: this harness knows
   * what a skill is, loads it with its own files beside it, and opens it when
   * it is due instead of carrying the whole text every round.
   */
  skills?: SkillDefinition[];
  workspace: RunWorkspace | null;
  onToolCall?: (call: ToolCallRecord) => void;
  /** Text the child wrote between tool calls: what it says it is doing. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
  /** Injectable so tests do not spawn a real CLI. */
  spawnCli?: typeof spawn;
  /** Full gateway base URL for the child; defaults to this server's own. */
  gatewayUrl?: string;
  /** API key the child authenticates to that gateway with. */
  authToken?: string;
  /** Attribution the gateway reads back off the child's requests. */
  sessionId?: string;
}

/** One line of `--output-format stream-json`, in the parts gate reads. */
interface StreamEvent {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      text?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

/** A tool result arrives as a string, or as content blocks when it is richer. */
function renderResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** The final `result` line, in the parts gate reads. */
interface CliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  session_id?: string;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/**
 * How many times the child may be shown its own validation error and asked again.
 *
 * Resumed, not re-run: the session already holds everything it read and decided,
 * so a correction costs one short turn rather than the whole node over.
 */
const MAX_OUTPUT_RETRIES = 2;

export async function runClaudeCodeNode(
  agent: AgentDefinition,
  prompt: string,
  nodeId: string,
  deps: ClaudeCodeDeps,
  deadline: number | null,
): Promise<{
  output: unknown;
  usage: NodeUsageRecord;
  toolCalls: ToolCallRecord[];
}> {
  if (!deps.workspace) {
    throw new WorkflowError(
      "AGENT_DEFINITION_INVALID",
      `node "${nodeId}": agent "${agent.id}" uses the claude-code executor, which needs a workspace; declare one on the workflow`,
      { nodeId, agentId: agent.id },
    );
  }
  // Captured once: the narrowing above does not survive into the closure below.
  const workspace = deps.workspace;
  if (!existsSync(workspace.root)) {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `node "${nodeId}": this run's worktree is gone (${workspace.root}); it was removed while the run was going`,
      { nodeId, agentId: agent.id },
    );
  }

  const skills = deps.skills ?? [];
  /**
   * Assembled before the first turn and reused by a correction round: building
   * it per turn would copy the same files again for a session that already has
   * the plugin loaded.
   */
  const skillPlugin = buildSkillPlugin(skills);

  const toolCalls: ToolCallRecord[] = [];
  const usage: NodeUsageRecord = {
    model: agent.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };

  /**
   * One turn of the child. `resume` continues the session it already has, so a
   * correction round does not pay for the node again — it costs one short turn.
   */
  const runTurn = async (
    userPrompt: string,
    resume?: string,
  ): Promise<CliResult> => {
    const args = [
      "-p",
      userPrompt,
      // Not `json`: that returns one blob when the node is already over, and the
      // dashboard has nothing to show for the half hour before it. `stream-json`
      // emits every tool call as it happens, which is what feeds tool.called.
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      agent.model,
      "--add-dir",
      workspace.root,
      // A run is unattended, so nothing may wait for an answer.
      //
      // Not `bypassPermissions`: Claude Code refuses that outright when the
      // process is root, which is how gate runs as a service — and it refuses
      // for a good reason, because that mode as root is unrestricted execution
      // on the host. `auto` decides without asking, and `--permission-prompts
      // none` denies whatever would still have prompted rather than hanging on
      // a question nobody is there to answer.
      "--permission-mode",
      "auto",
      "--permission-prompts",
      "none",
    ];
    if (agent.effort) args.push("--effort", agent.effort);
    if (resume) args.push("--resume", resume);
    // Built once per set of skills and reused; null when the agent named none.
    if (skillPlugin) args.push("--plugin-dir", skillPlugin);
    // What gate requires of the node, as opposed to what the harness already
    // knows: which skills this agent works by, and the shape of its answer.
    // Both ride as an appended system prompt rather than as the user turn, and
    // both are re-sent on a correction round, which resumes a session whose
    // system prompt is fixed at the turn it was given.
    const appended: string[] = [];
    // First, because it changes how the skills after it are to be read: a
    // headless child has nobody to answer it, whatever its skills expect.
    appended.push(unattendedNotice());
    if (skills.length) appended.push(skillsDirective(skills));
    if (agent.output.type === "json") {
      const fields = Object.entries(agent.output.schema)
        .map(([field, type]) => `  "${field}": ${type}`)
        .join("\n");
      appended.push(
        `When you have finished the work, your final message must be a single JSON object and nothing else — no prose, no code fence. Fields:\n{\n${fields}\n}\nA type ending in "?" is optional.`,
      );
    }
    if (appended.length) args.push("--append-system-prompt", appended.join("\n\n"));

    const spawnCli = deps.spawnCli ?? spawn;
    const child = spawnCli("claude", args, {
      cwd: workspace.root,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: gatewayUrl(deps.gatewayUrl),
        // Only set when the caller has one: on the server the gateway is
        // loopback and needs no key, and an empty value would be sent as one.
        ...(deps.authToken ? { ANTHROPIC_AUTH_TOKEN: deps.authToken, ANTHROPIC_API_KEY: deps.authToken } : {}),
        // Claude Code would otherwise send only its own session id, and the
        // gateway would file a node's calls as unrelated traffic. This is the
        // same header gate's own provider sets (`sessionFromRequest` prefers
        // it), so a node run by the child groups, sticks to its tier and reuses
        // its prompt cache exactly like one gate held itself.
        ...(deps.sessionId ? { ANTHROPIC_CUSTOM_HEADERS: `x-gate-session: ${deps.sessionId}` } : {}),
        // Empty unless this node runs on a provider model; see above.
        ...providerModelEnv(agent.model),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let final: CliResult | null = null;
    /** tool_use id -> what it asked for, until its result comes back. */
    const pending = new Map<
      string,
      { tool: string; input: unknown; startedAt: number }
    >();
    let buffered = "";

    const onEvent = (e: StreamEvent) => {
      if (e.type === "result") {
        final = e as unknown as CliResult;
        return;
      }
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (e.type === "assistant" && b.type === "text" && typeof b.text === "string") {
          deps.onText?.(b.text);
        }
        if (b.type === "tool_use" && typeof b.id === "string") {
          pending.set(b.id, {
            tool: b.name ?? "tool",
            input: b.input,
            startedAt: Date.now(),
          });
        }
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const started = pending.get(b.tool_use_id);
          pending.delete(b.tool_use_id);
          const record: ToolCallRecord = {
            tool: started?.tool ?? "tool",
            input: started?.input ?? null,
            ok: b.is_error !== true,
            result: renderResult(b.content),
            startedAt: started?.startedAt ?? Date.now(),
            durationMs: started ? Date.now() - started.startedAt : 0,
          };
          toolCalls.push(record);
          // The engine turns this into a tool.called event, so the dashboard
          // fills in while the node runs rather than only once it is over.
          deps.onToolCall?.(record);
        }
      }
    };

    child.stdout?.on("data", (c: Buffer) => {
      buffered += c.toString();
      // NDJSON: everything up to the last newline is complete; keep the rest.
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line) as StreamEvent);
        } catch {
          // A line that is not JSON is not fatal; the result event is what counts.
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

    const settled = await new Promise<{
      code: number | null;
      timedOut: boolean;
      cancelled: boolean;
    }>((resolve) => {
      let done = false;
      const finish = (r: {
        code: number | null;
        timedOut: boolean;
        cancelled: boolean;
      }) => {
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
      child.on("error", () =>
        finish({ code: null, timedOut: false, cancelled: false }),
      );
      child.on("close", (code) =>
        finish({ code, timedOut: false, cancelled: false }),
      );
    });

    // The last line carries no trailing newline, so it is still in the buffer —
    // and it is the `result` line, the one that matters most.
    if (buffered.trim()) {
      try {
        onEvent(JSON.parse(buffered) as StreamEvent);
      } catch {
        // Not JSON; `final` stays null and the error below says what came out.
      }
    }

    if (settled.cancelled) {
      throw new WorkflowError(
        "RUN_CANCELLED",
        `node "${nodeId}" was cancelled`,
        { nodeId },
      );
    }
    if (settled.timedOut) {
      throw new WorkflowError(
        "NODE_TIMEOUT",
        `node "${nodeId}" exceeded its timeout`,
        { nodeId },
      );
    }

    const parsed = final as CliResult | null;
    if (!parsed) {
      const detail = (stderr.trim() || "no output").slice(0, 500);
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `node "${nodeId}": claude-code exited ${settled.code ?? "without a code"} before reporting a result — ${detail}`,
        { nodeId, agentId: agent.id, toolCalls },
      );
    }

    // Every turn's spend counts, including a correction round.
    usage.model = modelOf(parsed) ?? usage.model;
    usage.inputTokens += parsed.usage?.input_tokens ?? 0;
    usage.outputTokens += parsed.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += parsed.usage?.cache_read_input_tokens ?? 0;

    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `node "${nodeId}": claude-code did not finish (${parsed.subtype ?? "unknown"})` +
          // Denials are silent otherwise, and a node that lost the tool it
          // needed reads exactly like one that simply answered badly.
          (parsed.permission_denials?.length
            ? `; ${parsed.permission_denials.length} tool call(s) denied by the permission mode`
            : ""),
        // The tool calls it did make and the tokens it did spend are attached, so
        // a failure is recorded with its evidence instead of looking like nothing.
        { nodeId, agentId: agent.id, usage, toolCalls },
      );
    }
    return parsed;
  };

  let turn = await runTurn(prompt);
  for (let attempt = 0; ; attempt++) {
    try {
      return {
        output: parseOutput(agent, turn.result as string, nodeId),
        usage,
        toolCalls,
      };
    } catch (e) {
      const validation =
        e instanceof WorkflowError &&
        e.code === "AGENT_OUTPUT_VALIDATION_ERROR";
      if (!validation || attempt >= MAX_OUTPUT_RETRIES || !turn.session_id)
        throw e;
      turn = await runTurn(
        outputCorrection((e as Error).message),
        turn.session_id,
      );
    }
  }
}

/** The concrete model the gateway routed to, when the child reported one. */
function modelOf(r: CliResult): string | null {
  const keys = r.modelUsage ? Object.keys(r.modelUsage) : [];
  return keys.length ? keys[0] : null;
}
