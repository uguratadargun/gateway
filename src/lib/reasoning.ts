import { loadSettings } from "./settings";

export type Effort = "none" | "low" | "medium" | "high";

const EFFORT_BUDGET: Record<string, number> = {
  none: 0,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/**
 * Inject extended-thinking config. Precedence: an explicit `x-gate-effort`
 * request header → the routed category's effort (from routing rules) → the
 * global default. Never overrides thinking the client already set.
 */
export function applyReasoning(
  body: Record<string, unknown>,
  effortHeader?: string | null,
  categoryEffort?: Effort | null,
): Effort {
  const effective = (
    effortHeader?.trim() ||
    categoryEffort ||
    loadSettings().reasoning.defaultEffort
  ).toLowerCase() as Effort;

  if (body.thinking) return effective; // client-controlled — leave alone

  const budget = EFFORT_BUDGET[effective];
  if (!budget) return "none";

  body.thinking = { type: "enabled", budget_tokens: budget };
  // Anthropic requires max_tokens > thinking budget; bump if needed.
  const maxTokens = Number(body.max_tokens ?? 0);
  if (maxTokens > 0 && maxTokens <= budget) {
    body.max_tokens = budget + 4096;
  }
  // Extended thinking requires temperature = 1 (or unset).
  if (body.temperature != null && body.temperature !== 1) delete body.temperature;
  return effective;
}
