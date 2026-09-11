import { randomBytes } from "node:crypto";

import { getDb } from "@/lib/db";
import { teamFamily, teamRoot } from "@/lib/teams";

import type {
  Decision,
  DecisionDraft,
  DecisionHit,
  DecisionOutcome,
  DecisionSearch,
  Extraction,
  ExtractionStatus,
  Feature,
  FeatureHit,
  FeatureImplementation,
  MemoryScope,
  Touch,
} from "./types";

/**
 * The memory tables, and the one way to read them: through a scope.
 *
 * Every read takes a `MemoryScope`, and the scope is put into the SQL — a
 * `team_id IN (...)` — rather than into a prompt. A team sees its own tree
 * and nothing else, and that holds whatever a model asks for.
 */

export const EXTRACTION_VERSION = 1;

/** How many times an extraction is tried before it stays failed. */
export const MAX_EXTRACTION_ATTEMPTS = 3;

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** What a caller on `teamId` may read. */
export function memoryScopeFor(teamId: string): MemoryScope {
  return { own: teamId, teams: teamFamily(teamId), orgId: teamRoot(teamId) };
}

// ── Full-text queries ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "are", "was", "were", "have",
  "has", "not", "but", "you", "your", "our", "its", "can", "should", "would", "could", "will", "all", "any", "also",
  "add", "make", "use", "using", "how", "what", "which", "where", "who", "does", "did", "one", "two", "new", "same",
  "bir", "ve", "ile", "için", "bu", "şu", "gibi", "olan", "olarak", "daha", "çok", "var", "yok", "ama", "veya",
]);

/**
 * Free text as an FTS5 query: every word a quoted term, longer words as
 * prefixes, joined with OR so that any of them matches and bm25 does the
 * ordering. Quoting is what keeps a user's text from being read as FTS
 * syntax — a stray `-` or `:` in a task would otherwise be an operator.
 */
export function toMatchQuery(text: string): string | null {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    terms.add(raw.length >= 4 ? `"${raw}"*` : `"${raw}"`);
    if (terms.size >= 24) break;
  }
  return terms.size ? [...terms].join(" OR ") : null;
}

// ── Features ─────────────────────────────────────────────────────────────────

function featureSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `feature-${randomBytes(3).toString("hex")}`;
}

function rowToFeature(r: any): Feature {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    aliases: parse<string[]>(r.aliases_json, []),
    summary: r.summary ?? "",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function writeFeatureIndex(f: Feature): void {
  const db = getDb();
  db.prepare("DELETE FROM memory_features_fts WHERE id = ?").run(f.id);
  db.prepare("INSERT INTO memory_features_fts (id, name, aliases, summary) VALUES (?,?,?,?)").run(
    f.id,
    f.name,
    f.aliases.join(" "),
    f.summary,
  );
}

export function getFeature(id: string): Feature | null {
  const row = getDb().prepare("SELECT * FROM memory_features WHERE id = ?").get(id);
  return row ? rowToFeature(row) : null;
}

/**
 * Creates or updates a catalogue entry. A new one gets an id from its name,
 * made unique within the gate: two trees may both have "offline sync", and
 * the second gets a suffix rather than the first's record.
 */
export function upsertFeature(input: {
  id?: string | null;
  orgId: string;
  name: string;
  aliases?: string[];
  summary?: string;
  now?: number;
}): Feature {
  const db = getDb();
  const now = input.now ?? Date.now();
  const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))];
  if (input.id) {
    const existing = getFeature(input.id);
    if (existing && existing.orgId !== input.orgId) throw new Error(`feature "${input.id}" belongs to another tree`);
    if (existing) {
      const merged = [...new Set([...existing.aliases, ...aliases])].filter((a) => a !== input.name);
      db.prepare("UPDATE memory_features SET name = ?, aliases_json = ?, summary = ?, updated_at = ? WHERE id = ?").run(
        input.name.trim() || existing.name,
        JSON.stringify(merged),
        input.summary?.trim() || existing.summary,
        now,
        input.id,
      );
      const updated = getFeature(input.id)!;
      writeFeatureIndex(updated);
      return updated;
    }
  }
  let id = input.id?.trim() || featureSlug(input.name);
  for (let n = 2; getFeature(id); n++) id = `${featureSlug(input.name)}-${n}`;
  db.prepare(
    "INSERT INTO memory_features (id, org_id, name, aliases_json, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, input.orgId, input.name.trim(), JSON.stringify(aliases.filter((a) => a !== input.name)), input.summary?.trim() ?? "", now, now);
  const created = getFeature(id)!;
  writeFeatureIndex(created);
  return created;
}

function teamsOfFeature(featureId: string): string[] {
  return (getDb().prepare("SELECT team_id FROM memory_feature_impls WHERE feature_id = ? ORDER BY team_id").all(featureId) as Array<{ team_id: string }>).map(
    (r) => r.team_id,
  );
}

export function listFeatures(scope: MemoryScope, limit = 500): FeatureHit[] {
  const rows = getDb()
    .prepare("SELECT * FROM memory_features WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(scope.orgId, limit) as any[];
  return rows.map((r) => ({ ...rowToFeature(r), score: 0, teams: teamsOfFeature(r.id) }));
}

/** Catalogue entries matching free text, best first. */
export function searchFeatures(scope: MemoryScope, query: string, limit = 10): FeatureHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT f.*, bm25(memory_features_fts, 0, 10, 8, 2) AS rank
         FROM memory_features_fts fts
         JOIN memory_features f ON f.id = fts.id
        WHERE memory_features_fts MATCH ? AND f.org_id = ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, scope.orgId, limit) as any[];
  return rows.map((r) => ({ ...rowToFeature(r), score: -Number(r.rank), teams: teamsOfFeature(r.id) }));
}

function rowToImplementation(r: any): FeatureImplementation {
  return {
    featureId: r.feature_id,
    teamId: r.team_id,
    summary: r.summary ?? "",
    pitfalls: r.pitfalls ?? "",
    decisionCount: Number(r.decision_count ?? 0),
    updatedAt: Number(r.updated_at),
  };
}

/** How one team built a feature. The count is recomputed from the decisions. */
export function upsertImplementation(input: {
  featureId: string;
  teamId: string;
  summary: string;
  pitfalls?: string;
  now?: number;
}): FeatureImplementation {
  const db = getDb();
  const now = input.now ?? Date.now();
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM memory_decisions WHERE feature_id = ? AND team_id = ? AND retracted_at IS NULL")
    .get(input.featureId, input.teamId) as { n: number };
  db.prepare(
    `INSERT INTO memory_feature_impls (feature_id, team_id, summary, pitfalls, decision_count, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(feature_id, team_id) DO UPDATE SET
       summary = excluded.summary, pitfalls = excluded.pitfalls,
       decision_count = excluded.decision_count, updated_at = excluded.updated_at`,
  ).run(input.featureId, input.teamId, input.summary.trim(), input.pitfalls?.trim() ?? "", Number(count.n), now);
  return getImplementation(input.featureId, input.teamId)!;
}

export function getImplementation(featureId: string, teamId: string): FeatureImplementation | null {
  const row = getDb().prepare("SELECT * FROM memory_feature_impls WHERE feature_id = ? AND team_id = ?").get(featureId, teamId);
  return row ? rowToImplementation(row) : null;
}

/** Every team's implementation of a feature that the scope may read. */
export function implementationsOf(scope: MemoryScope, featureId: string): FeatureImplementation[] {
  if (!scope.teams.length) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_feature_impls WHERE feature_id = ? AND team_id IN (${placeholders(scope.teams.length)})
        ORDER BY (team_id = ?) DESC, updated_at DESC`,
    )
    .all(featureId, ...scope.teams, scope.own) as any[];
  return rows.map(rowToImplementation);
}

// ── Decisions ────────────────────────────────────────────────────────────────

function rowToDecision(r: any): Decision {
  return {
    id: r.id,
    executionId: r.execution_id,
    teamId: r.team_id,
    userId: r.user_id ?? null,
    featureId: r.feature_id ?? null,
    title: r.title,
    context: r.context ?? "",
    decision: r.decision ?? "",
    rationale: r.rationale ?? "",
    alternatives: r.alternatives ?? "",
    how: r.how ?? "",
    consequences: r.consequences ?? "",
    touches: parse<Touch[]>(r.touches_json, []),
    supersedes: r.supersedes ?? null,
    baseCommit: r.base_commit ?? null,
    headCommit: r.head_commit ?? null,
    outcome: (r.outcome ?? "shipped") as DecisionOutcome,
    validFrom: Number(r.valid_from),
    validTo: r.valid_to == null ? null : Number(r.valid_to),
    recordedAt: Number(r.recorded_at),
    retractedAt: r.retracted_at == null ? null : Number(r.retracted_at),
  };
}

export function getDecision(id: string): Decision | null {
  const row = getDb().prepare("SELECT * FROM memory_decisions WHERE id = ?").get(id);
  return row ? rowToDecision(row) : null;
}

export function decisionsForExecution(executionId: string): Decision[] {
  return (getDb().prepare("SELECT * FROM memory_decisions WHERE execution_id = ? ORDER BY recorded_at, id").all(executionId) as any[]).map(rowToDecision);
}

function normaliseTouches(touches: Touch[]): Touch[] {
  const seen = new Set<string>();
  const out: Touch[] = [];
  for (const t of touches) {
    const ref = String(t.ref ?? "").trim().replace(/^\.\//, "");
    const kind = t.kind === "area" ? "area" : "file";
    if (!ref) continue;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, ref });
  }
  return out;
}

function writeDecisionIndex(d: Decision): void {
  const db = getDb();
  db.prepare("DELETE FROM memory_decisions_fts WHERE id = ?").run(d.id);
  db.prepare(
    "INSERT INTO memory_decisions_fts (id, title, context, decision, rationale, how, consequences, touches) VALUES (?,?,?,?,?,?,?,?)",
  ).run(d.id, d.title, d.context, d.decision, d.rationale, d.how, d.consequences, d.touches.map((t) => t.ref).join(" "));
  db.prepare("DELETE FROM memory_touches WHERE decision_id = ?").run(d.id);
  const ins = db.prepare("INSERT OR IGNORE INTO memory_touches (decision_id, kind, ref) VALUES (?,?,?)");
  for (const t of d.touches) ins.run(d.id, t.kind, t.ref);
}

/**
 * Writes a run's decisions, replacing what an earlier extraction of the same
 * run wrote. One transaction: a run's record is whole or absent, never half.
 */
export function replaceDecisions(
  run: {
    executionId: string;
    teamId: string;
    userId: string | null;
    featureId: string | null;
    baseCommit: string | null;
    headCommit: string | null;
    outcome: DecisionOutcome;
    validFrom: number;
  },
  drafts: DecisionDraft[],
  now = Date.now(),
): Decision[] {
  const db = getDb();
  db.exec("BEGIN");
  try {
    for (const old of decisionsForExecution(run.executionId)) {
      db.prepare("DELETE FROM memory_decisions_fts WHERE id = ?").run(old.id);
      db.prepare("DELETE FROM memory_touches WHERE decision_id = ?").run(old.id);
      db.prepare("DELETE FROM memory_decisions WHERE id = ?").run(old.id);
    }
    const written: Decision[] = [];
    drafts.forEach((draft, n) => {
      // Readable — the run's prefix and the decision's place in it — and
      // unique: two runs may share a prefix, so the tail is random and checked.
      let id = `${run.executionId.slice(0, 8)}-${n + 1}-${randomBytes(4).toString("hex")}`;
      while (getDecision(id)) id = `${run.executionId.slice(0, 8)}-${n + 1}-${randomBytes(4).toString("hex")}`;
      const supersedes = draft.supersedes && getDecision(draft.supersedes) ? draft.supersedes : null;
      const d: Decision = {
        id,
        executionId: run.executionId,
        teamId: run.teamId,
        userId: run.userId,
        featureId: run.featureId,
        title: draft.title.trim(),
        context: draft.context?.trim() ?? "",
        decision: draft.decision?.trim() ?? "",
        rationale: draft.rationale?.trim() ?? "",
        alternatives: draft.alternatives?.trim() ?? "",
        how: draft.how?.trim() ?? "",
        consequences: draft.consequences?.trim() ?? "",
        touches: normaliseTouches(draft.touches ?? []),
        supersedes,
        baseCommit: run.baseCommit,
        headCommit: run.headCommit,
        outcome: run.outcome,
        validFrom: run.validFrom,
        validTo: null,
        recordedAt: now,
        retractedAt: null,
      };
      db.prepare(
        `INSERT INTO memory_decisions
           (id, execution_id, team_id, user_id, feature_id, title, context, decision, rationale, alternatives, how,
            consequences, touches_json, base_commit, head_commit, outcome, supersedes, valid_from, valid_to, recorded_at, retracted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        d.id, d.executionId, d.teamId, d.userId, d.featureId, d.title, d.context, d.decision, d.rationale, d.alternatives,
        d.how, d.consequences, JSON.stringify(d.touches), d.baseCommit, d.headCommit, d.outcome, d.supersedes,
        d.validFrom, d.validTo, d.recordedAt, d.retractedAt,
      );
      writeDecisionIndex(d);
      // A superseded decision stops holding when the new one starts; its row
      // stays, closed, for the question "what did we believe on date D".
      if (supersedes) {
        db.prepare("UPDATE memory_decisions SET valid_to = COALESCE(valid_to, ?) WHERE id = ?").run(run.validFrom, supersedes);
      }
      written.push(d);
    });
    db.exec("COMMIT");
    return written;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Closes a decision that turned out wrong. The row stays; searches skip it. */
export function retractDecision(id: string, at = Date.now()): boolean {
  return Number(getDb().prepare("UPDATE memory_decisions SET retracted_at = ?, valid_to = COALESCE(valid_to, ?) WHERE id = ? AND retracted_at IS NULL").run(at, at, id).changes) > 0;
}

/**
 * Decisions the scope may read, best first.
 *
 * Text goes through FTS5 and bm25; paths go through the touches index as
 * prefixes; time through the bi-temporal columns. The caller's own team ranks
 * above the rest of its tree at equal relevance, so "how did we do X" answers
 * with our own X before a sibling's.
 */
export function searchDecisions(scope: MemoryScope, search: DecisionSearch): DecisionHit[] {
  if (!scope.teams.length) return [];
  const limit = Math.min(Math.max(search.limit ?? 20, 1), 200);
  const where: string[] = [`d.team_id IN (${placeholders(scope.teams.length)})`];
  const params: unknown[] = [...scope.teams];
  if (!search.includeRetracted) where.push("d.retracted_at IS NULL");
  if (search.featureId) {
    where.push("d.feature_id = ?");
    params.push(search.featureId);
  }
  if (search.asOf != null) {
    where.push("d.valid_from <= ? AND (d.valid_to IS NULL OR d.valid_to > ?)");
    params.push(search.asOf, search.asOf);
  }
  if (search.since != null) {
    where.push("d.valid_from >= ?");
    params.push(search.since);
  }
  const paths = (search.paths ?? []).map((p) => p.trim().replace(/^\.\//, "")).filter(Boolean);
  if (paths.length) {
    // A prefix as an index range on memory_touches(ref), not a LIKE: the
    // range is what lets 50k rows answer in a few milliseconds.
    // As an IN over the touches index rather than a correlated EXISTS: the
    // planner then walks the few touched rows first and probes decisions by
    // key, instead of asking the question once per decision in the scope.
    where.push(
      `d.id IN (SELECT t.decision_id FROM memory_touches t WHERE ${paths.map(() => "(t.ref >= ? AND t.ref < ?)").join(" OR ")})`,
    );
    for (const p of paths) params.push(p, `${p}\uffff`);
  }

  const match = search.query ? toMatchQuery(search.query) : null;
  if (match) {
    const rows = getDb()
      .prepare(
        `SELECT d.*, bm25(memory_decisions_fts, 0, 10, 2, 5, 3, 3, 1, 4) AS rank
           FROM memory_decisions_fts fts
           JOIN memory_decisions d ON d.id = fts.id
          WHERE memory_decisions_fts MATCH ? AND ${where.join(" AND ")}
          ORDER BY (d.team_id = ?) DESC, rank
          LIMIT ?`,
      )
      .all(match, ...params, scope.own, limit) as any[];
    return rows.map((r) => ({ ...rowToDecision(r), score: -Number(r.rank) }));
  }
  const rows = getDb()
    .prepare(
      `SELECT d.* FROM memory_decisions d
        WHERE ${where.join(" AND ")}
        ORDER BY (d.team_id = ?) DESC, d.valid_from DESC
        LIMIT ?`,
    )
    .all(...params, scope.own, limit) as any[];
  return rows.map((r) => ({ ...rowToDecision(r), score: 0 }));
}

// ── Extractions ──────────────────────────────────────────────────────────────

function rowToExtraction(r: any): Extraction {
  return {
    executionId: r.execution_id,
    teamId: r.team_id,
    status: r.status as ExtractionStatus,
    version: Number(r.version),
    attempts: Number(r.attempts),
    error: r.error ?? null,
    queuedAt: Number(r.queued_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    model: r.model ?? null,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    decisionCount: Number(r.decision_count ?? 0),
  };
}

/**
 * Puts a finished run in line to be recorded. Idempotent: the row is the
 * run's, and a second finish report changes nothing.
 */
export function queueExtraction(executionId: string, teamId: string, at = Date.now()): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO memory_extractions (execution_id, team_id, status, version, queued_at) VALUES (?,?,'pending',?,?)",
    )
    .run(executionId, teamId, EXTRACTION_VERSION, at);
}

export function getExtraction(executionId: string): Extraction | null {
  const row = getDb().prepare("SELECT * FROM memory_extractions WHERE execution_id = ?").get(executionId);
  return row ? rowToExtraction(row) : null;
}

/** Runs waiting to be recorded, or that failed and may be tried again. */
export function pendingExtractions(limit = 20): Extraction[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_extractions
        WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
        ORDER BY queued_at ASC
        LIMIT ?`,
    )
    .all(MAX_EXTRACTION_ATTEMPTS, limit) as any[];
  return rows.map(rowToExtraction);
}

/**
 * Takes a run for this process to record. True when this call got it; false
 * when another already has, or it is done, or it is out of attempts. The
 * update is the lock: SQLite runs one writer at a time, so two processes
 * asking at once see one `changes: 1` and one `changes: 0`.
 */
export function claimExtraction(executionId: string, at = Date.now()): boolean {
  return (
    Number(
      getDb()
        .prepare(
          `UPDATE memory_extractions
              SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL
            WHERE execution_id = ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?))`,
        )
        .run(at, executionId, MAX_EXTRACTION_ATTEMPTS).changes,
    ) > 0
  );
}

export function settleExtraction(
  executionId: string,
  outcome: {
    status: "done" | "failed" | "skipped";
    error?: string | null;
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number | null;
    decisionCount?: number;
  },
  at = Date.now(),
): void {
  getDb()
    .prepare(
      `UPDATE memory_extractions
          SET status = ?, error = ?, finished_at = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, decision_count = ?
        WHERE execution_id = ?`,
    )
    .run(
      outcome.status,
      outcome.error ?? null,
      at,
      outcome.model ?? null,
      outcome.inputTokens ?? 0,
      outcome.outputTokens ?? 0,
      outcome.costUsd ?? null,
      outcome.decisionCount ?? 0,
      executionId,
    );
}

/**
 * Asks for a run to be recorded again — from the dashboard, after a fix — or
 * for the first time, for a run that ended before there was a ledger.
 */
export function requeueExtraction(executionId: string, at = Date.now()): boolean {
  const db = getDb();
  const run = db.prepare("SELECT team_id, status FROM workflow_executions WHERE id = ?").get(executionId) as
    | { team_id: string | null; status: string }
    | undefined;
  if (!run || run.status === "running") return false;
  queueExtraction(executionId, run.team_id ?? "default", at);
  return (
    Number(
      db
        .prepare(
          `UPDATE memory_extractions
              SET status = 'pending', attempts = 0, error = NULL, version = ?, queued_at = ?, started_at = NULL, finished_at = NULL
            WHERE execution_id = ? AND status != 'running'`,
        )
        .run(EXTRACTION_VERSION, at, executionId).changes,
    ) > 0
  );
}

/**
 * Queues every finished run of these teams that has no ledger row: the runs
 * that ended before memory existed, or on a server that was down when they
 * did. Once, on request — each is a model call, so it is not done quietly.
 */
export function queueUnrecordedExecutions(teamIds: string[], at = Date.now()): number {
  if (!teamIds.length) return 0;
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.team_id FROM workflow_executions e
        WHERE e.status != 'running' AND COALESCE(e.team_id, 'default') IN (${placeholders(teamIds.length)})
          AND NOT EXISTS (SELECT 1 FROM memory_extractions x WHERE x.execution_id = e.id)
        ORDER BY e.finished_at ASC`,
    )
    .all(...teamIds) as Array<{ id: string; team_id: string | null }>;
  for (const r of rows) queueExtraction(r.id, r.team_id ?? "default", at);
  return rows.length;
}

/** A running extraction whose process died: put back in line after this long. */
const STALE_RUNNING_MS = 30 * 60_000;

export function releaseStaleExtractions(now = Date.now()): number {
  return Number(
    getDb()
      .prepare("UPDATE memory_extractions SET status = 'failed', error = 'the recorder did not finish' WHERE status = 'running' AND started_at < ?")
      .run(now - STALE_RUNNING_MS).changes,
  );
}

/** Everything recorded for one run, for the run's page. */
export function memoryOfExecution(executionId: string): { extraction: Extraction | null; decisions: Decision[]; feature: Feature | null } {
  const extraction = getExtraction(executionId);
  const decisions = decisionsForExecution(executionId);
  const featureId = decisions.find((d) => d.featureId)?.featureId ?? null;
  return { extraction, decisions, feature: featureId ? getFeature(featureId) : null };
}
