import { renderTemplate, TemplateError } from "@/agents/template";
import { buildOutputSchema, type AgentDefinition, type AgentOutputSpec } from "@/agents/types";
import type { ModelProvider, ModelProviderMessage, ToolResultBlock, ToolUseBlock } from "@/providers/types";
import { WorkflowError } from "@/runtime/errors";
import { resolveInputs, type NodeUsageRecord, type ToolCallRecord, type WorkflowState } from "@/runtime/state";
import { getTool, toolsFor } from "@/runtime/tools/registry";
import { ToolError, type ToolContext } from "@/runtime/tools/types";
import type { RunWorkspace } from "@/runtime/workspace";
import type { WorkflowNode } from "@/workflows/types";

/**
 * Runs one agent node: resolve declared inputs → prompt → model call. An agent
 * that declares tools keeps the turn going — model asks for a tool, the tool
 * runs inside the workspace, the result goes back — until the model answers in
 * prose, which is then validated against the agent's declared output shape.
 */

/** A model cannot keep calling tools forever; a stuck agent fails its node. */
const MAX_TOOL_ITERATIONS = 40;

export interface AgentExecutorDeps {
  provider: ModelProvider;
  loadAgent(id: string): AgentDefinition;
  /** Present only when the workflow declares one; without it there are no tools. */
  workspace?: RunWorkspace | null;
  onToolCall?: (call: ToolCallRecord) => void;
  maxToolIterations?: number;
}

export interface AgentNodeResult {
  input: Record<string, unknown>;
  output: unknown;
  usage: NodeUsageRecord;
  toolCalls: ToolCallRecord[];
}

export async function executeAgentNode(
  node: Extract<WorkflowNode, { type: "agent" }>,
  state: WorkflowState,
  deps: AgentExecutorDeps,
): Promise<AgentNodeResult> {
  const agent = deps.loadAgent(node.agent);
  // The node may narrow what the agent declared, never widen it.
  const paths = node.inputs ?? agent.inputs;
  const inputs = resolveInputs(paths, state, node.id);

  let prompt: string;
  try {
    prompt = renderTemplate(agent.prompt, { inputs, input: state.input });
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : String(e);
    throw new WorkflowError("AGENT_DEFINITION_INVALID", `node "${node.id}": ${message}`, { nodeId: node.id, agentId: agent.id });
  }

  const workspace = deps.workspace ?? null;
  const tools = toolsFor(agent.tools, Boolean(workspace));
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const toolCtx: ToolContext | null = workspace
    ? { root: workspace.root, nodeId: node.id, executionId: state.executionId }
    : null;

  const messages: ModelProviderMessage[] = [{ role: "user", content: prompt }];
  const toolCalls: ToolCallRecord[] = [];
  const usage: NodeUsageRecord = { model: agent.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const deadline = agent.timeoutMs ? Date.now() + agent.timeoutMs : null;
  const maxIterations = deps.maxToolIterations ?? MAX_TOOL_ITERATIONS;

  for (let iteration = 0; ; iteration++) {
    const call = deps.provider.execute({
      model: agent.model,
      system: systemPrompt(agent, tools.length > 0),
      messages,
      effort: agent.effort,
      maxTokens: agent.maxTokens,
      tools: toolDefs.length ? toolDefs : undefined,
      context: { executionId: state.executionId, workflowId: state.workflowId, nodeId: node.id },
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
      return { input: inputs, output: parseOutput(agent, result.text, node.id), usage, toolCalls };
    }
    if (iteration >= maxIterations) {
      throw new WorkflowError(
        "TOOL_LIMIT_EXCEEDED",
        `node "${node.id}": agent "${agent.id}" made ${maxIterations} tool rounds without answering`,
        { nodeId: node.id, agentId: agent.id },
      );
    }

    messages.push({ role: "assistant", content: result.content });
    const results: ToolResultBlock[] = [];
    for (const use of result.toolUses) {
      const record = await runTool(use, toolCtx, agent);
      toolCalls.push(record);
      deps.onToolCall?.(record);
      results.push({ type: "tool_result", toolUseId: use.id, content: record.result, isError: !record.ok });
    }
    messages.push({ role: "user", content: results });
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

function systemPrompt(agent: AgentDefinition, hasTools: boolean): string {
  const parts = [`You are the "${agent.name}" agent in an automated workflow.`];
  if (agent.description) parts.push(agent.description);
  if (hasTools) {
    parts.push(
      "You are working in a git worktree of the target repository. Tool paths are relative to its root. " +
        "Inspect before you change anything, make the smallest change that does the job, and verify it with the tools you have.",
    );
  }
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

/** Models add fences and commentary even when told not to; recover the object. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function parseOutput(agent: { id: string; output: AgentOutputSpec }, text: string, nodeId: string): unknown {
  if (agent.output.type === "text") return text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    throw new WorkflowError("AGENT_OUTPUT_VALIDATION_ERROR", `node "${nodeId}": agent "${agent.id}" did not return JSON`, {
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
function withDeadline<T>(p: Promise<T>, deadline: number | null, nodeId: string): Promise<T> {
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
