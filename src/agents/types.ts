import { z } from "zod";

import { EFFORTS, type Effort } from "@/lib/reasoning";

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
const FIELD_TYPES = ["string", "number", "boolean", "string[]", "number[]", "object", "any"] as const;
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
    /** Tier alias ("sonnet"), or a concrete "claude-*" id. Resolved by the existing router. */
    model: z.string().min(1).max(100).default("sonnet"),
    effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional(),
    /** Upstream node outputs this agent is allowed to read, e.g. "planner.plan". */
    inputs: z.array(z.string().min(1).max(200)).max(50).default([]),
    output: agentOutputSpecSchema.default({ type: "text" }),
    /** Tool names this agent may invoke. Declared now, unused until tools ship. */
    tools: z.array(z.string().min(1).max(64)).max(50).default([]),
    /** Hard cap on a single agent call, enforced by the runtime. No ceiling: some agents legitimately run long. */
    timeoutMs: z.number().int().min(1000).optional(),
    /**
     * Output ceiling per model call. Thinking counts against it, so an agent
     * that must return something long (a full diff) needs a bigger one than
     * the 8192 default.
     */
    maxTokens: z.number().int().min(1024).max(200_000).optional(),
    /**
     * Tool-call rounds a single node may make before the runtime gives up on
     * it (default 40). A long task that reads and edits its way through a
     * large repo for hours legitimately needs more than a quick one; no
     * ceiling here, since the timeout above is the real backstop.
     */
    maxToolIterations: z.number().int().min(1).optional(),
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
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
