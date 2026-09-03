import { loadSettings } from "./settings";

const EFFORT_BUDGET: Record<string, number> = {
  none: 0,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/**
 * Inject extended-thinking config based on the effective effort. Precedence:
 * an explicit `x-gate-effort` request header, else the configured default.
 * Never overrides thinking the client already set.
 */
export function applyReasoning(body: Record<string, unknown>, effortHeader?: string | null): void {
  if (body.thinking) return; // client-controlled — leave alone

  const effort = (effortHeader?.trim() || loadSettings().reasoning.defaultEffort).toLowerCase();
  const budget = EFFORT_BUDGET[effort];
  if (!budget) return; // "none" or unknown → no thinking

  body.thinking = { type: "enabled", budget_tokens: budget };
  // Anthropic requires max_tokens > thinking budget; bump if needed.
  const maxTokens = Number(body.max_tokens ?? 0);
  if (maxTokens > 0 && maxTokens <= budget) {
    body.max_tokens = budget + 4096;
  }
  // Extended thinking requires temperature = 1 (or unset).
  if (body.temperature != null && body.temperature !== 1) delete body.temperature;
}
