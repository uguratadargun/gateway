import { renderTemplate, TemplateError } from "@/agents/template";
import { buildOutputSchema, type AgentDefinition, type AgentOutputSpec } from "@/agents/types";
import { WorkflowError } from "@/runtime/errors";
import { resolveInputs, type WorkflowState } from "@/runtime/state";
import type { WorkflowNode } from "@/workflows/types";

/**
 * An agent node, before and after the model: its inputs resolved and its
 * prompt rendered, and the answer it handed back checked against the output
 * it declared. What happens in between is the person's own Claude Code.
 */

/** Everything a node needs before anyone runs it: who, with what, saying what. */
export interface PreparedAgentNode {
  agent: AgentDefinition;
  /** The declared inputs, resolved from upstream outputs. */
  inputs: Record<string, unknown>;
  /** The agent's prompt with those inputs filled in. */
  prompt: string;
}

/**
 * Resolves a node's inputs and renders its prompt — everything about an agent
 * node that is not the model's to do. The session driving a run, and the
 * subagent it starts, are handed exactly this.
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
