import { createHash } from "node:crypto";

import { ANTHROPIC_MESSAGES_URL } from "./claude/config";
import { applyClaudeCodeIdentity } from "./claude/identity";
import { getDb } from "./db";
import { loadRoutingConfig } from "./router";
import { getValidCredentials } from "./token-manager";
import { recordUsage } from "./usage";

/**
 * LLM difficulty judge (the "causal LLM router" from RouteLLM, zero training
 * data): Haiku rates the user's request 1–5. Only the query text is sent, not
 * the whole prompt, so a grade costs a few hundred Haiku tokens. Results are
 * cached by content hash.
 */

const RUBRIC = `You are a request router. Rate how much model intelligence the user's request needs, on a 1-5 scale:
1 = trivial: greetings, short factual lookups, tiny edits, formatting
2 = easy: simple questions, straightforward code snippets, summaries
3 = moderate: standard coding tasks, explanations, analysis with a few steps
4 = hard: multi-step reasoning, debugging complex systems, design/architecture decisions, subtle bugs
5 = expert: research-grade reasoning, proofs, long-horizon planning, novel algorithm design
Reply with ONLY the single digit.`;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHARS = 4000;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function gradeDifficulty(text: string): Promise<number | null> {
  const clipped = text.trim().slice(0, MAX_CHARS);
  if (!clipped) return null;
  const key = hash(clipped);
  const db = getDb();

  try {
    const row = db.prepare("SELECT grade, ts FROM grades WHERE hash = ?").get(key);
    if (row && Date.now() - Number(row.ts) < CACHE_TTL_MS) return Number(row.grade);
  } catch {
    // fall through
  }

  const creds = await getValidCredentials();
  if (!creds) return null;
  const model = loadRoutingConfig().tiers.haiku;
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4,
    system: RUBRIC,
    messages: [{ role: "user", content: clipped }],
  };
  const headers = applyClaudeCodeIdentity(body, {
    accessToken: creds.accessToken,
    cliUserID: creds.cliUserID,
    accountUUID: creds.account?.account_uuid ?? null,
    model,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const out = (json.content ?? []).map((b: any) => b.text ?? "").join("");
    const m = /[1-5]/.exec(out);
    if (!m) return null;
    const grade = Number(m[0]);
    const u = json.usage ?? {};
    recordUsage({
      ts: Date.now(),
      requested: "(grader)",
      model,
      tier: "haiku",
      reason: `grader → ${grade}`,
      status: 200,
      stream: false,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    });
    try {
      db.prepare("INSERT INTO grades (hash, grade, ts) VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET grade = excluded.grade, ts = excluded.ts").run(key, grade, Date.now());
      db.prepare("DELETE FROM grades WHERE hash NOT IN (SELECT hash FROM grades ORDER BY ts DESC LIMIT 5000)").run();
    } catch {
      // cache is best-effort
    }
    return grade;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
