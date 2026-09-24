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
 * answer, short enough to write by hand.
 *
 * A trailing "?" marks a field optional, and optional here means "there was
 * nothing to say": the key may be left out or written as null, and the two
 * are the same answer. See `buildOutputSchema`.
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
     * Which model runs this agent: a Claude Code alias ("sonnet", "opus", …)
     * or a concrete "claude-*" id. Every node runs on the person's own Claude
     * login, so a `provider:` reference — a model only a gateway could reach —
     * names something nothing can serve, and is refused.
     */
    model: z
      .string()
      .min(1)
      .max(100)
      .default("sonnet")
      .refine((m) => !/^(provider|local):/.test(m), {
        message: "a provider model cannot run here: every node runs on the person's own Claude login — use haiku, sonnet, opus, fable or a claude-* id",
      }),
    effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional(),
    /** Upstream node outputs this agent is allowed to read, e.g. "planner.plan". */
    inputs: z.array(z.string().min(1).max(200)).max(50).default([]),
    output: agentOutputSpecSchema.default({ type: "text" }),
    /**
     * Who does this agent's node in a run the person's session drives.
     *
     * `gate` is the session itself, with its own tools and model, in front of
     * the person, and able to ask them. `claude-code` is a subagent of the
     * session in the agent's own `model`, drawn live in the terminal, with a
     * context of its own that the harness compacts.
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
     * The tools this agent's role uses — the shape of the job, read by the
     * session. For `executor: gate` the names are gate's own (`read_file`,
     * `memory_search`, …); for `claude-code`, Claude Code's (`Read`, `Grep`,
     * `Bash`, …).
     */
    tools: z.array(z.string().min(1).max(64)).max(50).default([]),
    /**
     * Skills this agent works by, named as ids from the team's skill library.
     *
     * Not a hint: an agent that declares one is told to read and follow it,
     * every run, from the copy this machine pulled with the team's
     * definitions. That is what makes "the planner brainstorms" a property of
     * the definition rather than of how the prompt happened to be worded.
     */
    skills: z.array(z.string().regex(SKILL_ID_RE, "use lowercase letters, digits and dashes")).max(20).default([]),
    /**
     * How long one visit to this agent's node is expected to take. Past it the
     * person is told the node is overrunning; stopping it is theirs. Left out,
     * it is an hour; 0 turns the notice off. There is no upper bound.
     */
    timeoutMs: z.number().int().min(0).optional(),
    /**
     * Read by nothing since gate stopped running model calls of its own; still
     * accepted, so an agent file written before that keeps loading.
     */
    maxTokens: z.number().int().min(1024).max(200_000).optional(),
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
    shape[field] = optional ? optionalField(base) : base;
  }
  // Models routinely add commentary fields; extra keys are kept, not rejected.
  return z.object(shape).passthrough();
}

/**
 * An optional field, in both the spellings a model actually writes.
 *
 * Every optional field a shipped agent declares is a "say something only if
 * there is a problem" field — the verifier's `gaps`, the reviewer's
 * `feedback`, the planner's `conflicts`. A model handed a list of keys and
 * asked for a JSON object writes all of them and puts `null` in the empty
 * one; that is the same answer as leaving the key out, and refusing it threw
 * away a verifier's finished work mid-run rather than catching any mistake.
 *
 * Null is normalised to absent so that nothing downstream has to know which
 * spelling arrived: an edge reading `outputs.verifier.gaps`, and a prompt
 * interpolating it, see the field missing either way. A required field is
 * untouched — there, null is still wrong, and saying so is the point.
 */
function optionalField(base: z.ZodTypeAny): z.ZodTypeAny {
  return base
    .nullish()
    .transform((v) => v ?? undefined);
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
