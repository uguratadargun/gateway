import { renderTemplate, TemplateError } from "@/agents/template";
import { buildOutputSchema, type AgentDefinition, type AgentOutputSpec } from "@/agents/types";
import type { ModelProvider, ModelProviderMessage, ProviderContentBlock, ToolUseBlock } from "@/providers/types";
import type { MemoryAccess } from "@/memory/cards";
import { WorkflowError } from "@/runtime/errors";
import { resolveInputs, type NodeUsageRecord, type ToolCallRecord, type WorkflowState } from "@/runtime/state";
import { getTool, toolsFor } from "@/runtime/tools/registry";
import { skillsBriefing, unattendedNotice } from "@/skills/inject";
import { getSkill } from "@/skills/registry";
import type { SkillDefinition } from "@/skills/types";
import { ToolError, type ToolContext } from "@/runtime/tools/types";
import type { RunWorkspace } from "@/runtime/workspace";
import type { WorkflowNode } from "@/workflows/types";

import { runClaudeCodeNode } from "./claude-code";

/**
 * Runs one agent node: resolve declared inputs → prompt → model call. An agent
 * that declares tools keeps the turn going — model asks for a tool, the tool
 * runs inside the workspace, the result goes back — until the model answers in
 * prose, which is then validated against the agent's declared output shape.
 */

/**
 * No tool-round ceiling by default.
 *
 * A fixed number is always wrong for someone: 40 rounds is generous for a
 * question and nothing at all for an agent working through a large repository
 * for hours, and the run it kills has already been paid for. An agent or a run
 * that wants a cap sets one (0 or unset means none); the node timeout and the
 * Stop button are the backstops for one that is genuinely stuck.
 */
const MAX_TOOL_ITERATIONS = 0;

/**
 * How long one visit to an agent node may take when the agent names nothing.
 *
 * An agent that works through a large repository routinely runs half an hour,
 * so a default has to be generous enough that a healthy node never meets it —
 * but a default of "none" is worse than a long one: a node wedged on a
 * provider that never answers would then hang the run until someone noticed.
 * An hour is past any real node and short of a lost afternoon. `timeoutMs: 0`
 * turns it off deliberately.
 */
const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60_000;

/** The tools that leave something behind. An agent holding one is here to change code. */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Reconnaissance has no natural end.
 *
 * An agent asked to change a large repository will map the whole thing before
 * touching it, announce that it has enough evidence, and then go on mapping —
 * observed here as 111 reads and searches in a row without a single write, on
 * a prompt that said in as many words that the worktree was the deliverable.
 * Prose in the prompt loses to the pull of the next unread file; what breaks
 * the pattern is being told, in the loop, that nothing has been written yet.
 * So a writing agent gets that reminder once it has spent this many rounds
 * with nothing on disk, and again every so often until it starts.
 */
const RECON_ROUNDS_BEFORE_NUDGE = 12;
const NUDGE_EVERY_ROUNDS = 10;

/**
 * How many times an agent may be shown its own validation error and asked again.
 *
 * A model that returns findings as objects where the schema said strings has
 * done all the expensive work already — read the repository, formed the answer
 * — and got the packaging wrong. Killing the node there throws that away and,
 * on a parallel branch, takes the whole run with it: observed here as a review
 * that never reached the verdict, so a rejection never made it back to the
 * planner. Being told exactly what failed is enough to fix it, and costs one
 * short round instead of a run.
 */
const MAX_OUTPUT_RETRIES = 2;

/** What to send back when the answer did not match the declared shape. */
export function outputCorrection(message: string): string {
  return (
    `Your last message did not match the output shape this node declared: ${message}\n\n` +
    "Send the same answer again, corrected, as a single JSON object and nothing else — no prose, no code fence. " +
    "Do not redo any work; only the shape of the final message was wrong."
  );
}

export interface AgentExecutorDeps {
  provider: ModelProvider;
  loadAgent(id: string): AgentDefinition;
  /**
   * Resolves a skill an agent declared. Injectable and scope-bound for the same
   * reason `loadAgent` is: which library a name resolves in depends on whose
   * run this is.
   */
  loadSkill?: (id: string) => SkillDefinition;
  /** Present only when the workflow declares one; without it there are no tools. */
  workspace?: RunWorkspace | null;
  onToolCall?: (call: ToolCallRecord) => void;
  /** Tool rounds one agent may take before its node fails. 0 or unset = no cap. */
  maxToolIterations?: number;
  /** Cancels the run. Checked every tool round, not only between nodes: an
   *  agent working through a dozen tool calls must stop when asked. */
  signal?: AbortSignal;
  /**
   * How a spawned Claude Code reaches a gateway. Set by the client CLI, which
   * runs the engine on a developer's machine against the company server;
   * unset on the server, where the child talks to this process.
   */
  claudeCode?: { gatewayUrl?: string; authToken?: string };
  /** The team's memory, for agents that declare the memory tools. */
  memory?: MemoryAccess;
}

export interface AgentNodeResult {
  input: Record<string, unknown>;
  output: unknown;
  usage: NodeUsageRecord;
  toolCalls: ToolCallRecord[];
}

/** Everything a node needs before anyone runs it: who, with what, saying what. */
export interface PreparedAgentNode {
  agent: AgentDefinition;
  /** The declared inputs, resolved from upstream outputs. */
  inputs: Record<string, unknown>;
  /** The agent's prompt with those inputs filled in. */
  prompt: string;
}

/**
 * Resolves a node's inputs and renders its prompt — the half of running an
 * agent that does not involve a model.
 *
 * Separated because there is now more than one thing that runs an agent: this
 * file's own loop, a spawned Claude Code, and the session a developer is
 * sitting in, which asks the CLI what to do next and does it with its own
 * tools. All three have to be given the same prompt from the same inputs, and
 * the way to guarantee that is for there to be one place that builds it.
 */
export function prepareAgentNode(
  node: Extract<WorkflowNode, { type: "agent" }>,
  state: WorkflowState,
  loadAgent: (id: string) => AgentDefinition,
): PreparedAgentNode {
  const agent = loadAgent(node.agent);
  // The node may narrow what the agent declared, never widen it.
  const paths = node.inputs ?? agent.inputs;
  const inputs = resolveInputs(paths, state, node.id);

  try {
    return { agent, inputs, prompt: renderTemplate(agent.prompt, { inputs, input: state.input }) };
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : String(e);
    throw new WorkflowError("AGENT_DEFINITION_INVALID", `node "${node.id}": ${message}`, {
      nodeId: node.id,
      agentId: agent.id,
    });
  }
}

export async function executeAgentNode(
  node: Extract<WorkflowNode, { type: "agent" }>,
  state: WorkflowState,
  deps: AgentExecutorDeps,
): Promise<AgentNodeResult> {
  const { agent, inputs, prompt } = prepareAgentNode(node, state, deps.loadAgent);

  const skills = resolveSkills(agent, node.id, deps.loadSkill);

  const workspace = deps.workspace ?? null;
  // `?? default` and not `|| default`: an explicit 0 means no deadline at all.
  const nodeTimeoutMs = agent.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const nodeDeadline = nodeTimeoutMs > 0 ? Date.now() + nodeTimeoutMs : null;

  // The other loop. Same inputs, same prompt, same output contract — only who
  // holds the conversation and serves the tools changes.
  if (agent.executor === "claude-code") {
    const res = await runClaudeCodeNode(
      agent,
      prompt,
      node.id,
      {
        skills,
        workspace,
        onToolCall: deps.onToolCall,
        signal: deps.signal,
        gatewayUrl: deps.claudeCode?.gatewayUrl,
        authToken: deps.claudeCode?.authToken,
        sessionId: `workflow:${state.executionId}`,
      },
      nodeDeadline,
    );
    return { input: inputs, output: res.output, usage: res.usage, toolCalls: res.toolCalls };
  }

  const tools = toolsFor(agent.tools, Boolean(workspace));
  const canWrite = tools.some((t) => WRITE_TOOLS.has(t.name));
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  // Without a workspace the file tools are already filtered out above, so a
  // context with an empty root is only ever reached by the memory tools.
  const toolCtx: ToolContext | null =
    workspace || tools.length
      ? { root: workspace?.root ?? "", nodeId: node.id, executionId: state.executionId, memory: deps.memory }
      : null;

  const messages: ModelProviderMessage[] = [{ role: "user", content: prompt }];
  const toolCalls: ToolCallRecord[] = [];
  let writes = 0;
  const usage: NodeUsageRecord = { model: agent.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const deadline = nodeDeadline;
  const maxIterations = agent.maxToolIterations ?? deps.maxToolIterations ?? MAX_TOOL_ITERATIONS;
  let outputRetries = 0;

  try {
    for (let iteration = 0; ; iteration++) {
      if (deps.signal?.aborted) {
        throw new WorkflowError("RUN_CANCELLED", `node "${node.id}" was cancelled`, { nodeId: node.id });
      }
      const call = deps.provider.execute({
        model: agent.model,
        system: systemPrompt(agent, tools.length > 0, canWrite, skills),
        messages,
        effort: agent.effort,
        maxTokens: agent.maxTokens,
        tools: toolDefs.length ? toolDefs : undefined,
        context: { executionId: state.executionId, workflowId: state.workflowId, nodeId: node.id },
        signal: deps.signal,
      });

      const result = await withDeadline(call, deadline, node.id);
      usage.model = result.model;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadTokens += result.usage.cacheReadTokens;

      // A truncated answer is never valid JSON; say why instead of blaming the
      // model's formatting and sending the workflow round the retry loop.
      if (result.stopReason === "max_tokens") {
        throw new WorkflowError(
          "AGENT_OUTPUT_TRUNCATED",
          `node "${node.id}": agent "${agent.id}" hit its output limit (${agent.maxTokens ?? 8192} max tokens); raise maxTokens in the agent file`,
          { nodeId: node.id, agentId: agent.id },
        );
      }

      if (!result.toolUses.length) {
        try {
          return { input: inputs, output: parseOutput(agent, result.text, node.id), usage, toolCalls };
        } catch (e) {
          const validation = e instanceof WorkflowError && e.code === "AGENT_OUTPUT_VALIDATION_ERROR";
          if (!validation || outputRetries >= MAX_OUTPUT_RETRIES) throw e;
          outputRetries++;
          messages.push({ role: "assistant", content: result.content });
          messages.push({ role: "user", content: [{ type: "text", text: outputCorrection((e as Error).message) }] });
          continue;
        }
      }
      if (maxIterations > 0 && iteration >= maxIterations) {
        throw new WorkflowError(
          "TOOL_LIMIT_EXCEEDED",
          `node "${node.id}": agent "${agent.id}" made ${maxIterations} tool rounds without answering`,
          { nodeId: node.id, agentId: agent.id },
        );
      }

      messages.push({ role: "assistant", content: result.content });
      const results: ProviderContentBlock[] = [];
      for (const use of result.toolUses) {
        const record = await runTool(use, toolCtx, agent);
        toolCalls.push(record);
        deps.onToolCall?.(record);
        if (record.ok && WRITE_TOOLS.has(use.name)) writes++;
        results.push({ type: "tool_result", toolUseId: use.id, content: record.result, isError: !record.ok });
      }
      // Rides along with the tool results rather than as a turn of its own, so
      // the reminder costs no extra model call.
      const nudge = canWrite && writes === 0 ? reconNudge(iteration + 1, toolCalls.length) : null;
      if (nudge) results.push({ type: "text", text: nudge });
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    // A node that fails partway through has still made real tool calls and
    // spent real tokens; both are attached here, so a failure keeps the
    // evidence instead of the engine recording it as if nothing happened.
    if (e instanceof WorkflowError) throw new WorkflowError(e.code, e.message, { ...e.detail, toolCalls, usage });
    throw e;
  }
}

/** Tool failures go back to the model as results: it can read the error and retry. */
async function runTool(use: ToolUseBlock, ctx: ToolContext | null, agent: AgentDefinition): Promise<ToolCallRecord> {
  const startedAt = Date.now();
  const base = { tool: use.name, input: use.input, startedAt };
  const tool = getTool(use.name);
  if (!tool || !agent.tools.includes(use.name) || !ctx) {
    return { ...base, ok: false, durationMs: 0, result: `tool "${use.name}" is not available to this agent` };
  }
  try {
    const result = await tool.execute((use.input ?? {}) as Record<string, unknown>, ctx);
    return { ...base, ok: true, durationMs: Date.now() - startedAt, result };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `${(e as Error).message}`;
    return { ...base, ok: false, durationMs: Date.now() - startedAt, result: `error: ${message}` };
  }
}

/** Null until the agent has surveyed for too long; then the same reminder, periodically. */
function reconNudge(rounds: number, toolCallCount: number): string | null {
  if (rounds < RECON_ROUNDS_BEFORE_NUDGE) return null;
  if ((rounds - RECON_ROUNDS_BEFORE_NUDGE) % NUDGE_EVERY_ROUNDS !== 0) return null;
  return (
    `You have made ${toolCallCount} tool calls in this node and have not written anything to the worktree yet. ` +
    "The worktree is the deliverable: nothing downstream reads this answer for the change itself, and a node that " +
    "ends with an unchanged worktree fails. Apply the part of the change you already understand, now, with " +
    "write_file or edit_file — then keep reading between edits instead of before them."
  );
}

export function systemPrompt(
  agent: AgentDefinition,
  hasTools: boolean,
  canWrite: boolean,
  skills: SkillDefinition[] = [],
): string {
  const parts = [`You are the "${agent.name}" agent in an automated workflow.`];
  if (agent.description) parts.push(agent.description);
  if (hasTools) {
    parts.push(
      canWrite
        ? "You are working in a git worktree of the target repository, and that worktree is your output: every " +
            "change you decide on, you apply there yourself with the write and edit tools. Nothing reads your final " +
            "answer for the change itself. Work change by change — read what the edit in front of you needs, make it, " +
            "verify it, move on — rather than surveying the whole repository first and writing at the end. Tool paths " +
            "are relative to the worktree root."
        : "You are working in a git worktree of the target repository. Tool paths are relative to its root. Read " +
            "what you need, and base what you report on what you actually read rather than on what a name suggests.",
    );
  }
  // Before the skills, because it changes how they are to be read: this loop
  // has no tool for asking, so a skill that would stop for a person cannot.
  parts.push(unattendedNotice());
  // Before the output contract, never after it: the shape of the final message
  // is the last thing a model should have been told.
  const briefing = skillsBriefing(skills);
  if (briefing) parts.push(briefing.trim());
  if (agent.output.type === "json") {
    const fields = Object.entries(agent.output.schema)
      .map(([field, type]) => `  "${field}": ${type}`)
      .join("\n");
    parts.push(
      `${hasTools ? "When you are done working, your final message must be a single JSON object" : "Respond with a single JSON object"} and nothing else — no prose, no code fence. Fields:\n{\n${fields}\n}\nA type ending in "?" is optional.`,
    );
  }
  return parts.join("\n\n");
}

/**
 * The skill definitions an agent named, or a failure that says which one is
 * gone.
 *
 * A skill can disappear between the save that validated it and the run that
 * needs it — deleted from the library, or a team's own copy removed so the
 * name no longer resolves. Failing here with the name is the difference
 * between a node that says what is missing and one that quietly runs without
 * the process it was defined to follow.
 */
function resolveSkills(
  agent: AgentDefinition,
  nodeId: string,
  loadSkill: ((id: string) => SkillDefinition) | undefined,
): SkillDefinition[] {
  if (!agent.skills.length) return [];
  const load = loadSkill ?? getSkill;
  return agent.skills.map((id) => {
    try {
      return load(id);
    } catch {
      throw new WorkflowError(
        "AGENT_DEFINITION_INVALID",
        `node "${nodeId}": agent "${agent.id}" declares skill "${id}", which is not in this team's skill library`,
        { nodeId, agentId: agent.id },
      );
    }
  });
}

/**
 * Models add fences and commentary even when told not to; recover the object.
 *
 * The text as a whole is tried first. The fence and brace heuristics exist
 * for a chatty answer, and applied to a clean one they can break it: a
 * planner's notes are JSON strings that themselves contain markdown fences,
 * and the first fence found was inside a string value — measured here, a
 * valid 11 KB output refused as "did not return JSON".
 */
function extractJson(text: string): string {
  const whole = text.trim();
  try {
    JSON.parse(whole);
    return whole;
  } catch {
    // fall through to the heuristics
  }
  const fenced = whole.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : whole).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

export function parseOutput(agent: { id: string; output: AgentOutputSpec }, text: string, nodeId: string): unknown {
  if (agent.output.type === "text") return text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (e) {
    // The parser's own words: a session handed a refusal with no reason once
    // went looking for one by experiment, on a live run.
    const reason = e instanceof Error ? e.message : String(e);
    throw new WorkflowError("AGENT_OUTPUT_VALIDATION_ERROR", `node "${nodeId}": agent "${agent.id}" did not return JSON (${reason})`, {
      nodeId,
      agentId: agent.id,
      text: text.slice(0, 2000),
    });
  }
  const validated = buildOutputSchema(agent.output).safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WorkflowError("AGENT_OUTPUT_VALIDATION_ERROR", `node "${nodeId}": agent "${agent.id}" output invalid — ${detail}`, {
      nodeId,
      agentId: agent.id,
    });
  }
  return validated.data;
}

/** The agent's timeout covers the whole tool loop, not one model call. */
export function withDeadline<T>(p: Promise<T>, deadline: number | null, nodeId: string): Promise<T> {
  if (!deadline) return p;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new WorkflowError("NODE_TIMEOUT", `node "${nodeId}" ran out of time`, { nodeId }));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new WorkflowError("NODE_TIMEOUT", `node "${nodeId}" exceeded its timeout`, { nodeId })),
      remaining,
    );
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
