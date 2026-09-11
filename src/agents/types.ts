import { z } from "zod";

import { EFFORTS, type Effort } from "@/lib/reasoning";
import { SKILL_ID_RE } from "@/skills/types";

/**
 * Agent definitions are Markdown files: YAML frontmatter describes how the
 * agent is run, the body is the prompt template.
 */

/**
 * Field types an agent may declare for its structured output. A compact
 * vocabulary rather than full JSON Schema — enough to validate a model's
 * answer, short enough to write by hand. A trailing "?" marks a field
 * optional.
 */
export const FIELD_TYPES = ["string", "number", "boolean", "string[]", "number[]", "object", "object[]", "any"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const fieldSpec = z.string().refine(
  (s) => (FIELD_TYPES as readonly string[]).includes(s.replace(/\?$/, "")),
  (s) => ({ message: `unknown field type "${s}" (expected one of ${FIELD_TYPES.join(", ")}, optionally with "?")` }),
);

export const agentOutputSpecSchema = z.union([
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json"), schema: z.record(z.string().min(1), fieldSpec) }),
]);
export type AgentOutputSpec = z.infer<typeof agentOutputSpecSchema>;

export const agentFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    /**
     * Which model runs this agent. A tier alias ("sonnet") the router resolves
     * per run, a concrete "claude-*" id that pins it, or
     * `provider:<name>/<model>` for one of the configured providers — an
     * Ollama on this machine, a hosted endpoint like Z.AI. A provider model is
     * still routed, metered and counted against the run's budget; it just puts
     * nothing on the Anthropic bill.
     */
    model: z.string().min(1).max(100).default("sonnet"),
    effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional(),
    /** Upstream node outputs this agent is allowed to read, e.g. "planner.plan". */
    inputs: z.array(z.string().min(1).max(200)).max(50).default([]),
    output: agentOutputSpecSchema.default({ type: "text" }),
    /**
     * Which loop runs this agent's node.
     *
     * `gate` is the built-in one: gate holds the conversation and serves its own
     * six tools. `claude-code` hands the node to a headless Claude Code in the
     * worktree instead — better tools, and a harness that compacts its context
     * rather than appending every tool result until the node re-reads 100K a
     * round. Routing, metering and the run budget are unaffected either way:
     * the child is pointed at this gate's own gateway.
     *
     * It is a separate axis from `model`, and every combination is valid: the
     * Claude Code harness driving a GLM on Z.AI is `executor: claude-code` with
     * `model: provider:zai/glm-4.6`, and gate's own loop on the same model is
     * the same line with `executor: gate`. The harness names the loop, not the
     * vendor.
     */
    executor: z.enum(["gate", "claude-code"]).default("gate"),
    /**
     * Whose turn the node is. Any value marks an agent that exists to put
     * something in front of the person and carry back their answer — the
     * shipped clarify, plan-review and acceptance gates. A run driven from a
     * session is *paused* while such a node is out: the dashboard says so,
     * and its clock stops, because the time is the person's and not the
     * run's. No effect on how the node is executed.
     *
     * The value says what kind of turn it is, for whatever puts the node in
     * front of the person: `question` wants an answer in their words (the
     * shipped clarify), `approval` wants a yes or a change (plan-review,
     * acceptance). `person` is the older spelling and means only "theirs";
     * it is read as a question.
     */
    asks: z.enum(["person", "question", "approval"]).optional(),
    /**
     * Tool names this agent may invoke. Which names are valid depends on the
     * executor: gate's own (`read_file`, `edit_file`, …) or Claude Code's
     * (`Read`, `Edit`, `Grep`, `Bash`, …).
     */
    tools: z.array(z.string().min(1).max(64)).max(50).default([]),
    /**
     * Skills this agent works by, named as ids from the team's skill library.
     *
     * Not a hint: an agent that declares one is told to follow it, every run.
     * A spawned Claude Code gets them as a plugin, so a skill loads with its
     * own files beside it and the harness opens it when it is due; gate's own
     * loop has nowhere to put a file and folds the prose into the system
     * prompt instead. Either way the skill's instructions reach the model,
     * which is what makes "the planner brainstorms" a property of the
     * definition rather than of how the prompt happened to be worded.
     */
    skills: z.array(z.string().regex(SKILL_ID_RE, "use lowercase letters, digits and dashes")).max(20).default([]),
    /**
     * Wall-clock cap on one visit to this agent's node — every tool round it
     * takes counts against it, not each model call separately. Left out, it is
     * an hour, which is past any healthy node; 0 turns it off entirely for an
     * agent that genuinely runs longer. There is no upper bound.
     */
    timeoutMs: z.number().int().min(0).optional(),
    /**
     * Output ceiling per model call. Thinking counts against it, so an agent
     * that must return something long (a full diff) needs a bigger one than
     * the 8192 default.
     */
    maxTokens: z.number().int().min(1024).max(200_000).optional(),
    /**
     * Tool-call rounds a single node may make before the runtime gives up on
     * it. Unset — or 0 — means no cap, which is the default: a long task that
     * reads and edits its way through a large repo for hours legitimately
     * needs more rounds than anyone can name up front, and the timeout above
     * is the real backstop. Set it only to hold a known-cheap agent short.
     */
    maxToolIterations: z.number().int().min(0).optional(),
  })
  .strict();

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface AgentDefinition extends AgentFrontmatter {
  /** File basename without extension; how workflow nodes reference the agent. */
  id: string;
  /** Markdown body — the prompt template. */
  prompt: string;
  sourcePath: string;
  updatedAt: number;
}

/** A tool an agent may call. The boundary between reasoning and side effects. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown): Promise<unknown>;
}

/** Build a zod validator for an agent's declared output shape. */
export function buildOutputSchema(spec: AgentOutputSpec): z.ZodTypeAny {
  if (spec.type === "text") return z.string();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [field, raw] of Object.entries(spec.schema)) {
    const optional = raw.endsWith("?");
    const base = fieldValidator(raw.replace(/\?$/, "") as FieldType);
    shape[field] = optional ? base.optional() : base;
  }
  // Models routinely add commentary fields; extra keys are kept, not rejected.
  return z.object(shape).passthrough();
}

function fieldValidator(t: FieldType): z.ZodTypeAny {
  switch (t) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "string[]":
      return z.array(z.string());
    case "number[]":
      return z.array(z.number());
    // A list of findings is the shape a reviewer reaches for on its own, and
    // without this the vocabulary could say `object` but not a list of them —
    // so the model returned objects, the schema demanded strings, and the node
    // died on the mismatch every single run.
    case "object[]":
      return z.array(z.record(z.string(), z.unknown()));
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
