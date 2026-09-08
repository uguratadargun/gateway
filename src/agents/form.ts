/**
 * The agent editor's form model: the frontmatter as a set of controls, and the
 * two conversions between that and the file.
 *
 * Kept out of the component because this is the part that can silently lose a
 * field — a key the form does not carry is a key that disappears the first
 * time someone saves — so it is plain data with tests, not JSX.
 */

export interface AgentEditorOptions {
  modelTiers: string[];
  models: string[];
  /** Non-Claude endpoints, one group per configured provider. */
  providerGroups: Array<{ label: string; models: string[] }>;
  modelSource: "live" | "fallback";
  efforts: string[];
  executors: string[];
  fieldTypes: readonly string[];
  gateTools: string[];
  /** The team's skill library, own and inherited, for the assignment control. */
  skills: Array<{ id: string; name: string; description: string }>;
}

export interface OutputField {
  field: string;
  type: string;
  optional: boolean;
}

/** The frontmatter, in the shape the controls hold it. Numbers stay strings so
 *  an emptied box means "unset" rather than zero. */
export interface AgentForm {
  name: string;
  description: string;
  model: string;
  effort: string;
  executor: string;
  inputs: string[];
  outputType: "text" | "json";
  outputFields: OutputField[];
  tools: string[];
  skills: string[];
  timeoutMs: string;
  maxTokens: string;
  maxToolIterations: string;
}

interface LoadedAgent {
  name: string;
  description?: string;
  model: string;
  effort?: string;
  executor?: string;
  inputs: string[];
  output: { type: string; schema?: Record<string, string> };
  tools: string[];
  skills?: string[];
  timeoutMs?: number;
  maxTokens?: number;
  maxToolIterations?: number;
}

export function formFromAgent(a: LoadedAgent): AgentForm {
  const schema = a.output.schema ?? {};
  return {
    name: a.name,
    description: a.description ?? "",
    model: a.model,
    effort: a.effort ?? "",
    executor: a.executor ?? "gate",
    inputs: [...a.inputs],
    outputType: a.output.type === "json" ? "json" : "text",
    outputFields: Object.entries(schema).map(([field, raw]) => ({
      field,
      type: raw.replace(/\?$/, ""),
      optional: raw.endsWith("?"),
    })),
    tools: [...a.tools],
    skills: [...(a.skills ?? [])],
    timeoutMs: a.timeoutMs === undefined ? "" : String(a.timeoutMs),
    maxTokens: a.maxTokens === undefined ? "" : String(a.maxTokens),
    maxToolIterations: a.maxToolIterations === undefined ? "" : String(a.maxToolIterations),
  };
}

/** A control's text as a whole number, or undefined when it was left empty. */
export function num(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * The object the server serializes. Keys are written in this order, so a file
 * saved from the form reads top-to-bottom the way the form does, and an empty
 * control leaves its key out entirely rather than writing a hollow one.
 *
 * `executor` is always written even though `gate` is the default: it is the
 * field people did not know they had, and a file that names it teaches the
 * next reader that there is a choice.
 */
export function frontmatterFrom(form: AgentForm): Record<string, unknown> {
  const schema: Record<string, string> = {};
  for (const f of form.outputFields) {
    const field = f.field.trim();
    if (field) schema[field] = f.optional ? `${f.type}?` : f.type;
  }
  const tools = form.tools.map((t) => t.trim()).filter(Boolean);
  return {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    model: form.model.trim(),
    effort: form.effort || undefined,
    executor: form.executor,
    inputs: form.inputs.map((i) => i.trim()).filter(Boolean),
    output: form.outputType === "json" ? { type: "json", schema } : { type: "text" },
    // Claude Code brings its own tools, so a list here would be written and
    // then ignored — the control is disabled in that mode and the key goes too.
    tools: form.executor === "gate" && tools.length ? tools : undefined,
    // Written for both executors, unlike `tools`: a skill means the same thing
    // whichever loop is running the node, only the delivery differs.
    skills: form.skills.length ? form.skills : undefined,
    timeoutMs: num(form.timeoutMs),
    maxTokens: num(form.maxTokens),
    maxToolIterations: num(form.maxToolIterations),
  };
}

/** Minutes in the box, milliseconds in the file: nobody reasons in 3600000. */
export function minutesOf(ms: string): string {
  const n = num(ms);
  if (n === undefined) return "";
  return String(Math.round((n / 60_000) * 100) / 100);
}
