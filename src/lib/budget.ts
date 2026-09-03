import { loadSettings } from "./settings";
import { getSpend } from "./usage";

export interface BudgetStatus {
  enabled: boolean;
  mode: "warn" | "block";
  today: number;
  month: number;
  dailyUsd: number;
  monthlyUsd: number;
  /** True when either window is over budget. */
  exceeded: boolean;
  reason: string | null;
}

export function checkBudget(): BudgetStatus {
  const cfg = loadSettings().budget;
  const { today, month } = getSpend();
  let exceeded = false;
  let reason: string | null = null;
  if (cfg.enabled) {
    if (cfg.dailyUsd > 0 && today >= cfg.dailyUsd) {
      exceeded = true;
      reason = `daily budget reached ($${today.toFixed(2)} / $${cfg.dailyUsd})`;
    } else if (cfg.monthlyUsd > 0 && month >= cfg.monthlyUsd) {
      exceeded = true;
      reason = `monthly budget reached ($${month.toFixed(2)} / $${cfg.monthlyUsd})`;
    }
  }
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    today,
    month,
    dailyUsd: cfg.dailyUsd,
    monthlyUsd: cfg.monthlyUsd,
    exceeded,
    reason,
  };
}
