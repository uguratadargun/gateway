import { getDb } from "./db";
import { costFor, savingsVsOpus, tierOf } from "./pricing";

export interface UsageEvent {
  ts: number;
  requested: string;
  model: string;
  tier: string;
  reason: string;
  status: number;
  inputTokens?: number;
  outputTokens?: number;
  stream: boolean;
}

export interface UsageSummary {
  total: number;
  byTier: Record<string, number>;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** Est. API-equivalent cost (USD) of the routed traffic. */
  cost: number;
  /** Est. cost had every request run on Opus (USD). */
  costAllOpus: number;
  /** costAllOpus - cost: what routing to cheaper tiers saved. */
  savings: number;
  recent: UsageEvent[];
}

export function recordUsage(e: UsageEvent): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO usage (ts,requested,model,tier,reason,status,stream,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(e.ts, e.requested, e.model, e.tier, e.reason, e.status, e.stream ? 1 : 0, e.inputTokens ?? 0, e.outputTokens ?? 0);
  } catch {
    // usage logging is best-effort
  }
}

interface ModelAgg {
  model: string;
  input: number;
  output: number;
  n: number;
}

function aggregateByModel(sinceTs: number): ModelAgg[] {
  return getDb()
    .prepare(
      "SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS n FROM usage WHERE ts >= ? GROUP BY model",
    )
    .all(sinceTs) as ModelAgg[];
}

function costOf(rows: ModelAgg[]): number {
  return rows.reduce((sum, r) => sum + costFor(tierOf(r.model), Number(r.input), Number(r.output)), 0);
}

/** Total est. cost (USD) spent today and this calendar month. O(models), not O(rows). */
export function getSpend(): { today: number; month: number } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { today: costOf(aggregateByModel(startOfDay)), month: costOf(aggregateByModel(startOfMonth)) };
}

export function readUsage(limit = 50): UsageSummary {
  const db = getDb();
  const byModelRows = aggregateByModel(0);
  const byTierRows = db.prepare("SELECT tier, COUNT(*) AS n FROM usage GROUP BY tier").all() as Array<{ tier: string; n: number }>;

  const summary: UsageSummary = {
    total: 0,
    byTier: {},
    byModel: {},
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    costAllOpus: 0,
    savings: 0,
    recent: [],
  };
  for (const r of byModelRows) {
    const input = Number(r.input);
    const output = Number(r.output);
    summary.total += Number(r.n);
    summary.byModel[r.model] = Number(r.n);
    summary.inputTokens += input;
    summary.outputTokens += output;
    const tier = tierOf(r.model);
    summary.cost += costFor(tier, input, output);
    summary.costAllOpus += costFor("opus", input, output);
    summary.savings += savingsVsOpus(tier, input, output);
  }
  for (const r of byTierRows) summary.byTier[r.tier] = Number(r.n);

  summary.recent = (
    db
      .prepare(
        "SELECT ts, requested, model, tier, reason, status, stream, input_tokens, output_tokens FROM usage ORDER BY ts DESC LIMIT ?",
      )
      .all(limit) as any[]
  ).map((r) => ({
    ts: Number(r.ts),
    requested: r.requested ?? "",
    model: r.model,
    tier: r.tier,
    reason: r.reason ?? "",
    status: Number(r.status),
    stream: !!r.stream,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
  return summary;
}
