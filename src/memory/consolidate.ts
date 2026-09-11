import { z } from "zod";

import { getDb } from "@/lib/db";
import { costForUsage, tierOf } from "@/lib/pricing";
import { loadSettings } from "@/lib/settings";
import type { ModelProvider } from "@/providers/types";

import { getDecision, getFeature, getImplementation, searchDecisions, upsertImplementation } from "./store";
import type { Decision, MemoryScope } from "./types";

/**
 * The consolidation pass: a team's summary of a feature, rewritten from
 * every decision under it.
 *
 * The recorder updates the summary one run at a time, which drifts: the
 * fifth run's recorder sees the fourth's summary and its own run, not the
 * first three. Every so many decisions this reads them all — shipped,
 * abandoned, superseded — and writes the summary and the pitfalls whole,
 * and says which decisions no longer hold because a later one replaced them.
 * The decisions themselves are not rewritten: a superseded one is closed
 * (valid_to) and stays for "what did we believe then". Nothing is deleted,
 * and a merge of two catalogue entries is proposed to a person, not done.
 */

const NODE_ID = "memory-consolidator";
const MAX_DECISION_CHARS = 6_000;
const MAX_TOTAL_CHARS = 150_000;

const answerSchema = z.object({
  summary: z.string().max(6_000).default(""),
  pitfalls: z.string().max(4_000).default(""),
  /** Decisions a later one replaced: the old id, the new id, and why. */
  superseded: z.array(z.object({ id: z.string().max(100), by: z.string().max(100), reason: z.string().max(500).default("") })).max(50).default([]),
  /** Another catalogue entry that is the same feature, if the summaries show it. Proposed, not applied. */
  duplicateOf: z.string().max(100).nullish(),
});

export type ConsolidationAnswer = z.infer<typeof answerSchema>;

export interface ConsolidationOutcome {
  status: "done" | "failed" | "skipped";
  reason?: string;
  decisionsRead: number;
  superseded: number;
  duplicateOf?: string | null;
}

export const CONSOLIDATOR_SYSTEM = `You maintain one team's page on one feature in an engineering team's memory. You are given the feature, the team's current summary of how it built it, and every decision the team's runs recorded under it — in the order they were made, each with its outcome (shipped, unshipped, abandoned) and whether it still holds.

Write the page again, whole, from all of them:
- "summary": how this team's implementation works now, at the level of logic — the flow, the components and their responsibilities, the invariants, the edge cases handled. What a sibling team needs to build the same thing on another platform. Later decisions win over earlier ones where they conflict; abandoned attempts are not the implementation, but what they learned may belong in pitfalls.
- "pitfalls": what the next change here must know — the traps recorded, the trade-offs taken, the assumptions that hold the thing up. Keep every pitfall that is still true; drop one only when a later decision removed the trap.
- "superseded": pairs of decision ids where a later decision replaced an earlier one on the same question, with why — only when it is plainly the same question and the later one still holds. When unsure, leave it out; a wrong closure hides a decision that still holds.
- "duplicateOf": the id of another catalogue entry you are shown that is the same feature under another name, or null. This is a proposal for a person; do not fold anything yourself.

Logic, never code. Cite decision ids in the summary where it helps. Answer with one JSON object and nothing else: {"summary": "...", "pitfalls": "...", "superseded": [{"id": "...", "by": "...", "reason": "..."}], "duplicateOf": "<id>" | null}`;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated]` : s;
}

function describe(d: Decision): string {
  return truncate(
    [
      `### ${d.id} · ${d.outcome} · from ${new Date(d.validFrom).toISOString().slice(0, 10)}${d.validTo ? ` to ${new Date(d.validTo).toISOString().slice(0, 10)} (no longer holds)` : ""}${d.supersedes ? ` · supersedes ${d.supersedes}` : ""}`,
      `title: ${d.title}`,
      d.context && `context: ${d.context}`,
      d.decision && `decision: ${d.decision}`,
      d.rationale && `rationale: ${d.rationale}`,
      d.alternatives && `alternatives: ${d.alternatives}`,
      d.how && `how: ${d.how}`,
      d.consequences && `consequences: ${d.consequences}`,
      d.touches.length && `touches: ${d.touches.map((t) => t.ref).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n"),
    MAX_DECISION_CHARS,
  );
}

/** What the model reads: the feature, the page as it stands, every decision, the neighbours. */
export function consolidatorPrompt(input: {
  feature: { id: string; name: string; aliases: string[]; summary: string };
  teamId: string;
  current: { summary: string; pitfalls: string } | null;
  decisions: Decision[];
  neighbours: Array<{ id: string; name: string; summary: string }>;
}): string {
  const parts = [
    `# ${input.feature.name} (${input.feature.id})`,
    input.feature.aliases.length ? `also: ${input.feature.aliases.join(", ")}` : "",
    input.feature.summary,
    `\nTeam: ${input.teamId}`,
    `\n## The page as it stands\n`,
    input.current ? `summary: ${input.current.summary || "(none)"}\npitfalls: ${input.current.pitfalls || "(none)"}` : "(no page yet)",
    `\n## Every decision, oldest first (${input.decisions.length})\n`,
  ];
  let budget = MAX_TOTAL_CHARS;
  for (const d of input.decisions) {
    const text = describe(d);
    if (budget <= 0) {
      parts.push(`[${d.id}: omitted, the record is long]`);
      continue;
    }
    parts.push(text.length > budget ? truncate(text, budget) : text, "");
    budget -= text.length;
  }
  parts.push(`\n## Other catalogue entries in this tree (for "duplicateOf")\n`);
  parts.push(input.neighbours.length ? input.neighbours.map((n) => `- ${n.id}: ${n.name} — ${n.summary || "(no summary)"}`).join("\n") : "(none)");
  return parts.filter((p) => p !== "").join("\n");
}

export function parseConsolidatorAnswer(text: string): ConsolidationAnswer {
  const attempts = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  let lastError: unknown = null;
  for (const candidate of attempts) {
    try {
      return answerSchema.parse(JSON.parse(candidate));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`the consolidator did not answer in the shape asked for: ${lastError instanceof Error ? lastError.message.split("\n")[0] : "not JSON"}`);
}

/** Implementations with enough new decisions since their last pass. */
export function dueConsolidations(every: number, limit = 5): Array<{ featureId: string; teamId: string }> {
  if (every <= 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT feature_id, team_id FROM memory_feature_impls
        WHERE decision_count - COALESCE(consolidated_count, 0) >= ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(every, limit) as Array<{ feature_id: string; team_id: string }>;
  return rows.map((r) => ({ featureId: r.feature_id, teamId: r.team_id }));
}

/**
 * One pass over one team's implementation of one feature. Recorded in the
 * consolidation ledger whatever happens, so the cost and the outcome are on
 * the feature's page.
 */
export async function consolidateImplementation(
  scope: MemoryScope,
  featureId: string,
  teamId: string,
  provider: ModelProvider,
  opts: { model?: string; now?: () => number } = {},
): Promise<ConsolidationOutcome> {
  const now = opts.now ?? Date.now;
  const model = opts.model ?? loadSettings().memory.model;
  const db = getDb();
  const feature = getFeature(featureId);
  if (!feature || feature.orgId !== scope.orgId || !scope.teams.includes(teamId)) {
    return { status: "skipped", reason: "no such feature in this tree", decisionsRead: 0, superseded: 0 };
  }
  const decisions = searchDecisions(scope, { featureId, limit: 200, includeRetracted: false })
    .filter((d) => d.teamId === teamId)
    .sort((a, b) => a.validFrom - b.validFrom);
  if (!decisions.length) return { status: "skipped", reason: "no decisions to read", decisionsRead: 0, superseded: 0 };

  const startedAt = now();
  const ledger = db
    .prepare("INSERT INTO memory_consolidations (feature_id, team_id, status, started_at, decisions_read) VALUES (?,?,'running',?,?)")
    .run(featureId, teamId, startedAt, decisions.length);
  const ledgerId = Number((ledger as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);
  const settle = (patch: { status: string; error?: string | null; model?: string | null; inputTokens?: number; outputTokens?: number; costUsd?: number | null; superseded?: number }) =>
    db
      .prepare(
        "UPDATE memory_consolidations SET status = ?, finished_at = ?, error = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, superseded = ? WHERE id = ?",
      )
      .run(patch.status, now(), patch.error ?? null, patch.model ?? null, patch.inputTokens ?? 0, patch.outputTokens ?? 0, patch.costUsd ?? null, patch.superseded ?? 0, ledgerId);

  try {
    const current = getImplementation(featureId, teamId);
    const neighbours = (db.prepare("SELECT id, name, summary FROM memory_features WHERE org_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 40").all(scope.orgId, featureId) as Array<{
      id: string;
      name: string;
      summary: string;
    }>);
    const prompt = consolidatorPrompt({ feature, teamId, current: current ? { summary: current.summary, pitfalls: current.pitfalls } : null, decisions, neighbours });
    const result = await provider.execute({
      model,
      system: CONSOLIDATOR_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 8_000,
      context: { nodeId: NODE_ID },
    });
    const usage = {
      model: result.model,
      inputTokens: result.usage.inputTokens + result.usage.cacheReadTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: costForUsage(
        tierOf(result.model),
        { input: result.usage.inputTokens, output: result.usage.outputTokens, cacheRead: result.usage.cacheReadTokens, cacheCreation: 0 },
        { model: result.model },
      ),
    };
    let answer: ConsolidationAnswer;
    try {
      answer = parseConsolidatorAnswer(result.text);
    } catch (e) {
      settle({ status: "failed", error: (e as Error).message, ...usage });
      return { status: "failed", reason: (e as Error).message, decisionsRead: decisions.length, superseded: 0 };
    }

    const known = new Set(decisions.map((d) => d.id));
    let superseded = 0;
    for (const pair of answer.superseded) {
      // Only this team's decisions under this feature, both ends real, the
      // later one still holding, and never a decision closing itself.
      if (pair.id === pair.by || !known.has(pair.id) || !known.has(pair.by)) continue;
      const older = getDecision(pair.id)!;
      const newer = getDecision(pair.by)!;
      if (newer.validFrom < older.validFrom || newer.validTo != null || older.validTo != null) continue;
      db.prepare("UPDATE memory_decisions SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(newer.validFrom, older.id);
      if (!newer.supersedes) db.prepare("UPDATE memory_decisions SET supersedes = ? WHERE id = ?").run(older.id, newer.id);
      superseded++;
    }
    const duplicateOf = answer.duplicateOf && neighbours.some((n) => n.id === answer.duplicateOf) ? answer.duplicateOf : null;
    upsertImplementation({ featureId, teamId, summary: answer.summary || current?.summary || "", pitfalls: answer.pitfalls || current?.pitfalls || "", now: now() });
    db.prepare("UPDATE memory_feature_impls SET consolidated_count = decision_count, consolidated_at = ? WHERE feature_id = ? AND team_id = ?").run(now(), featureId, teamId);
    settle({ status: "done", ...usage, superseded });
    return { status: "done", decisionsRead: decisions.length, superseded, duplicateOf };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    settle({ status: "failed", error: message });
    return { status: "failed", reason: message, decisionsRead: decisions.length, superseded: 0 };
  }
}

export interface ConsolidationRecord {
  id: number;
  featureId: string;
  teamId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  decisionsRead: number;
  superseded: number;
  error: string | null;
}

/** The passes made over one feature, newest first, for its page. */
export function consolidationsOf(featureId: string, limit = 10): ConsolidationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM memory_consolidations WHERE feature_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(featureId, limit) as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    featureId: r.feature_id,
    teamId: r.team_id,
    status: r.status,
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    model: r.model ?? null,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    decisionsRead: Number(r.decisions_read ?? 0),
    superseded: Number(r.superseded ?? 0),
    error: r.error ?? null,
  }));
}
