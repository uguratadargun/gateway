import { loadSettings } from "./settings";

/**
 * Capability-aware reasoning control.
 *
 * Anthropic's guidance (Sept 2026): effort is the primary lever for cost and
 * thinking depth, and it beats switching models. The API default is `high`,
 * so *not* setting effort is the expensive choice. Mechanics differ by model:
 *
 * - Adaptive-thinking models (Fable/Mythos, Opus 5, Opus 4.6–4.8, Sonnet 5,
 *   Sonnet 4.6): steer with `output_config.effort`; `thinking.enabled` +
 *   `budget_tokens` is rejected (400) on 4.7+ and deprecated on 4.6.
 * - Extended-only models (Haiku 4.5, Sonnet 4.5, Opus 4.5, older): no effort
 *   parameter (400 on Haiku); depth comes from `thinking.enabled` budgets.
 *
 * Whatever the client already set is respected: Claude Code sends its own
 * effort, and changing it mid-conversation would also break prompt caching.
 */

export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];

const RANK: Record<Effort, number> = { default: 3, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

export function effortRank(e: Effort): number {
  return RANK[e];
}

/** Accepts legacy "none" (pre-v2 config) and unknown values. */
export function normalizeEffort(v: unknown): Effort {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  if (s === "none" || s === "") return "default";
  return (EFFORTS as string[]).includes(s) ? (s as Effort) : "default";
}

export type ThinkingMode = "adaptive" | "extended" | "none";

const ADAPTIVE_RE = /fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6/;
const EXTENDED_RE = /haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|sonnet-4-2|opus-4-2|haiku-3/;
const XHIGH_RE = /fable|mythos|opus-5|opus-4-[78]|sonnet-5/;
/** Adaptive models where thinking defaults to OFF (needs an explicit adaptive block). */
const ADAPTIVE_OFF_BY_DEFAULT_RE = /opus-4-[678]|sonnet-4-6/;

export function thinkingModeFor(model: string): ThinkingMode {
  const m = model.toLowerCase();
  if (ADAPTIVE_RE.test(m)) return "adaptive";
  if (EXTENDED_RE.test(m)) return "extended";
  return "none";
}

export function effortSupported(model: string): boolean {
  const m = model.toLowerCase();
  return ADAPTIVE_RE.test(m) || /opus-4-5/.test(m);
}

/** Floor for max_tokens when gate raises effort to high or above. */
const HIGH_EFFORT_MIN_MAX_TOKENS = 8192;

/** budget_tokens for extended-only models, by effort. 0 = no thinking. */
const EXTENDED_BUDGET: Record<Effort, number> = {
  default: 0,
  low: 0,
  medium: 2048,
  high: 8192,
  xhigh: 16384,
  max: 32000,
};

/**
 * Apply the effective effort to `body` for `model`. Precedence: explicit
 * `x-gate-effort` header → routed category/session effort → global default.
 * Returns the effective effort (even when the client's own config wins).
 */
export function applyReasoning(
  body: Record<string, unknown>,
  effortHeader: string | null | undefined,
  categoryEffort: Effort | null | undefined,
  model: string,
): Effort {
  const effective = normalizeEffort(
    effortHeader?.trim() || categoryEffort || loadSettings().reasoning.defaultEffort,
  );

  const outputConfig = (body.output_config as Record<string, unknown> | undefined) ?? undefined;
  const clientSet = body.thinking != null || outputConfig?.effort != null;
  if (clientSet) return effective; // client-controlled (e.g. Claude Code)
  if (effective === "default") return effective; // API default == high; omit = identical

  const m = model.toLowerCase();
  const mode = thinkingModeFor(model);

  if (effortSupported(model)) {
    let e: Effort = effective;
    if (e === "xhigh" && !XHIGH_RE.test(m)) e = "high";
    body.output_config = { ...(outputConfig ?? {}), effort: e };
    if (mode === "adaptive" && ADAPTIVE_OFF_BY_DEFAULT_RE.test(m) && effortRank(e) >= effortRank("high")) {
      body.thinking = { type: "adaptive" };
    }
    // Thinking counts toward max_tokens; at high+ effort a small client limit
    // gets eaten by thinking and the answer is truncated (Anthropic: "set a
    // large max_tokens at high and above"). Only raised when gate chose the
    // effort, and only the ceiling — actual spend is unchanged.
    const maxTokens = Number(body.max_tokens ?? 0);
    if (effortRank(e) >= effortRank("high") && maxTokens > 0 && maxTokens < HIGH_EFFORT_MIN_MAX_TOKENS) {
      body.max_tokens = HIGH_EFFORT_MIN_MAX_TOKENS;
    }
    if (mode === "extended") applyBudget(body, EXTENDED_BUDGET[e]); // Opus 4.5: effort + budget
    return e;
  }

  if (mode === "extended") applyBudget(body, EXTENDED_BUDGET[effective]);
  return effective;
}

function applyBudget(body: Record<string, unknown>, budget: number): void {
  if (!budget) return;
  body.thinking = { type: "enabled", budget_tokens: budget };
  const maxTokens = Number(body.max_tokens ?? 0);
  if (maxTokens > 0 && maxTokens <= budget) body.max_tokens = budget + 4096;
  if (body.temperature != null && body.temperature !== 1) delete body.temperature;
}

/**
 * Translate a client's reasoning parameters to what the *target* model
 * accepts. A router that swaps the model underneath a client (Claude Code
 * sends `output_config.effort` + `thinking: adaptive` on every request) must
 * do this, or Haiku answers 400 "does not support the effort parameter" and
 * Claude 5 rejects `thinking.enabled`. Mutates and returns `body`.
 */
export function sanitizeForModel(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const m = model.toLowerCase();
  const mode = thinkingModeFor(model);
  const thinking = body.thinking as Record<string, unknown> | undefined;
  const outputConfig = body.output_config as Record<string, unknown> | undefined;

  if (!effortSupported(model) && outputConfig && "effort" in outputConfig) {
    const { effort: _drop, ...rest } = outputConfig;
    if (Object.keys(rest).length) body.output_config = rest;
    else delete body.output_config;
  }

  if (mode === "extended") {
    // No adaptive mode here; "disabled" is the default anyway.
    if (thinking && (thinking.type === "adaptive" || thinking.type === "disabled")) delete body.thinking;
  } else if (mode === "adaptive") {
    const alwaysOn = /fable|mythos/.test(m);
    const rejectsEnabled = alwaysOn || /opus-5|opus-4-[78]|sonnet-5/.test(m);
    if (thinking?.type === "enabled" && rejectsEnabled) {
      // budget_tokens → effort, then adaptive.
      const budget = Number(thinking.budget_tokens ?? 0);
      const oc = (body.output_config as Record<string, unknown> | undefined) ?? {};
      if (oc.effort == null) {
        body.output_config = { ...oc, effort: budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high" };
      }
      body.thinking = { type: "adaptive" };
    }
    if (thinking?.type === "disabled") {
      const effort = String((body.output_config as Record<string, unknown> | undefined)?.effort ?? "high");
      // Always-on models reject "disabled"; Opus 5+ rejects it at xhigh/max.
      if (alwaysOn || effort === "xhigh" || effort === "max") delete body.thinking;
    }
  }

  foldSystemMessages(body, model);

  // Context-management edits that require thinking (clear_thinking_*) are
  // invalid once thinking is absent or disabled on the target model.
  const t = body.thinking as Record<string, unknown> | undefined;
  const thinkingOn = mode === "adaptive" ? t?.type !== "disabled" : t?.type === "enabled";
  const cm = body.context_management as Record<string, unknown> | undefined;
  if (!thinkingOn && cm && Array.isArray(cm.edits)) {
    const edits = (cm.edits as Array<Record<string, unknown>>).filter((e) => !String(e.type ?? "").startsWith("clear_thinking"));
    if (edits.length) body.context_management = { ...cm, edits };
    else delete body.context_management;
  }
  return body;
}

/** Models that accept a per-message `output_config` on a system message. */
const PER_MESSAGE_EFFORT_RE = /fable-5-1|mythos-5-1|opus-5/;

function textBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/**
 * Mid-conversation `role: "system"` messages (Claude Code sends them for
 * reminders and per-message effort). Extended-only models reject the role
 * outright, so their text is folded into the next user turn; models without
 * per-message effort get the `output_config` stripped.
 */
function foldSystemMessages(body: Record<string, unknown>, model: string): void {
  if (!Array.isArray(body.messages)) return;
  const msgs = body.messages as Array<Record<string, unknown>>;
  if (!msgs.some((m) => m.role === "system")) return;
  const m = model.toLowerCase();
  const supportsRole = thinkingModeFor(model) === "adaptive";
  const supportsPerMsgEffort = PER_MESSAGE_EFFORT_RE.test(m);

  const out: Array<Record<string, unknown>> = [];
  let pending: Array<Record<string, unknown>> = [];
  const flushInto = (target: Record<string, unknown> | null) => {
    if (!pending.length) return;
    if (target && target.role === "user") {
      target.content = [...pending, ...textBlocks(target.content)];
    } else {
      out.push({ role: "user", content: pending });
    }
    pending = [];
  };

  for (const msg of msgs) {
    if (msg.role !== "system") {
      if (pending.length) {
        if (msg.role === "user") {
          const merged = { ...msg };
          flushInto(merged);
          out.push(merged);
          continue;
        }
        flushInto(null);
      }
      out.push(msg);
      continue;
    }
    const cleaned = { ...msg };
    if (!supportsPerMsgEffort) delete cleaned.output_config;
    const blocks = textBlocks(cleaned.content);
    if (supportsRole) {
      if (blocks.length || cleaned.output_config) out.push(cleaned);
      continue;
    }
    pending.push(...blocks);
  }
  flushInto(null);
  body.messages = out;
}
