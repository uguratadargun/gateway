import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * SQLite persistence via Node's built-in `node:sqlite`. Loaded through
 * process.getBuiltinModule so the bundler leaves it alone and no native
 * module build is needed. One DB at ~/.gate/gate.db (WAL mode).
 */

export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  requested TEXT,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT,
  status INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS traffic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT,
  requested TEXT,
  routed TEXT,
  tier TEXT,
  status INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  from_cache INTEGER NOT NULL DEFAULT 0,
  request_preview TEXT,
  response_preview TEXT
);
CREATE INDEX IF NOT EXISTS traffic_ts ON traffic(ts);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  stored_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apikeys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grades (
  hash TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ratelimit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  util_5h REAL,
  util_7d REAL,
  status TEXT,
  reset_at INTEGER
);
CREATE INDEX IF NOT EXISTS rl_ts ON ratelimit_history(ts);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_json TEXT,
  error_code TEXT,
  error_message TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  workspace_json TEXT
);
CREATE INDEX IF NOT EXISTS wf_exec_started ON workflow_executions(started_at);
CREATE INDEX IF NOT EXISTS wf_exec_workflow ON workflow_executions(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  execution_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  visit INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls_json TEXT,
  PRIMARY KEY (execution_id, step_index)
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- What the user typed: a path, or a git URL gate cloned from.
  source TEXT NOT NULL,
  -- Where it is on disk, which is what a run's worktree branches from.
  root TEXT NOT NULL,
  -- 1 when gate created the checkout, and so may remove it again.
  cloned INTEGER NOT NULL DEFAULT 0,
  base_ref TEXT,
  -- argv arrays: setup runs once in the repo, prepare in every worktree.
  setup_json TEXT NOT NULL DEFAULT '[]',
  prepare_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  last_setup_at INTEGER,
  last_setup_log TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The git URL skills are pulled from; the clone below is gate's own.
  url TEXT NOT NULL,
  -- Branch or tag to track; NULL follows whatever the remote's default is.
  ref TEXT,
  -- Where skill directories live inside that repository.
  subdir TEXT NOT NULL DEFAULT 'skills',
  -- Prepended to a skill's id on import, so two libraries can both ship
  -- "brainstorming" without one silently replacing the other.
  prefix TEXT NOT NULL DEFAULT '',
  root TEXT NOT NULL,
  -- The commit the clone is on, which is what an imported skill is stamped with.
  head_sha TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  last_sync_at INTEGER,
  last_sync_log TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  -- AES-256-GCM sealed StoredCredentials; never plaintext at rest.
  sealed TEXT NOT NULL,
  account_uuid TEXT,
  email TEXT,
  organization TEXT,
  plan_tier TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Lower = preferred. Pool order for fill-first and every tie-break.
  priority INTEGER NOT NULL DEFAULT 100,
  last_used_at INTEGER,
  -- Sticky round-robin bookkeeping: requests served in a row.
  consecutive_use_count INTEGER NOT NULL DEFAULT 0,
  -- Exponential cooldown level; reset by a confirmed success.
  backoff_level INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  last_error TEXT,
  -- Upstream quota snapshot: the 5h / 7d unified windows.
  quota_json TEXT,
  quota_fetched_at INTEGER,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_uuid ON accounts(account_uuid) WHERE account_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  -- Slug used in model references: local:<name>/<model>.
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai-compat',
  base_url TEXT NOT NULL,
  -- Sealed; null for an endpoint that needs no auth (Ollama, LM Studio).
  api_key_sealed TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  -- Identity as the company knows it; one person, one row.
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  team_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_team ON users(team_id);

CREATE TABLE IF NOT EXISTS workflow_layouts (
  workflow_id TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- ── Memory: what a run decided, kept for the runs that come after it ─────────
--
-- A run's steps say what happened; these say what was decided and why, at the
-- level of logic rather than code, so a later run can read "how did the android
-- team do offline sync" or "which runs touched src/sync/" without replaying
-- every step. Raw rows are never rewritten: a decision that stops being true is
-- closed with retracted_at, and a new one names it in supersedes.

-- The shared feature catalogue of one team tree. Owned by the root team of the
-- tree so every team under it reads the same names; an implementation row
-- below says how one team built it.
CREATE TABLE IF NOT EXISTS memory_features (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON string[]: other names the same feature goes by.
  aliases_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_features_org ON memory_features(org_id);

CREATE TABLE IF NOT EXISTS memory_feature_impls (
  feature_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  pitfalls TEXT NOT NULL DEFAULT '',
  decision_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (feature_id, team_id)
);

CREATE TABLE IF NOT EXISTS memory_decisions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT,
  feature_id TEXT,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  alternatives TEXT NOT NULL DEFAULT '',
  how TEXT NOT NULL DEFAULT '',
  consequences TEXT NOT NULL DEFAULT '',
  -- JSON: [{kind: "file"|"area", ref}] — what the decision touched.
  touches_json TEXT NOT NULL DEFAULT '[]',
  base_commit TEXT,
  head_commit TEXT,
  -- shipped: the run ended at a completed terminal; unshipped: the branch
  -- exists but did not reach its merge request; abandoned: the run failed or
  -- was stopped. An abandoned decision is still a decision — "we tried X and
  -- the reviewer refused it because Y" is worth keeping.
  outcome TEXT NOT NULL DEFAULT 'shipped',
  supersedes TEXT,
  -- Bi-temporal: when the decision held in the world, and when this row was
  -- written and closed. "What was believed on date D" is a range query.
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  recorded_at INTEGER NOT NULL,
  retracted_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_decisions_execution ON memory_decisions(execution_id);
CREATE INDEX IF NOT EXISTS memory_decisions_team ON memory_decisions(team_id, valid_from);
CREATE INDEX IF NOT EXISTS memory_decisions_feature ON memory_decisions(feature_id);

-- One row per thing a decision touched, so "which decisions touched src/x/"
-- is an index range rather than a scan of JSON.
CREATE TABLE IF NOT EXISTS memory_touches (
  decision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (decision_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS memory_touches_ref ON memory_touches(ref);

-- The extraction ledger: one row per run, claimed and settled so the same run
-- is never written twice, and a failed extraction is retried, not lost.
CREATE TABLE IF NOT EXISTS memory_extractions (
  execution_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  decision_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_extractions_status ON memory_extractions(status, queued_at);

-- Full-text indexes. Kept by the store, not by triggers, so the text a query
-- matches is exactly the text the store wrote.
-- Porter stemming, so "notify" finds "notifications" and "synced" finds
-- "sync": the words a person asks with are rarely the recorder's exact forms.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_decisions_fts USING fts5(
  id UNINDEXED, title, context, decision, rationale, how, consequences, touches, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_features_fts USING fts5(
  id UNINDEXED, name, aliases, summary, tokenize = 'porter unicode61'
);
`;

/**
 * Rebuilds a full-text index whose tokenizer is not the one the schema names.
 *
 * CREATE IF NOT EXISTS leaves an existing table as it was, tokenizer and all,
 * so a change to how text is indexed would otherwise apply only to fresh
 * installs. The index is derived from the base table, so rebuilding it loses
 * nothing: drop, create, and fill it again from the rows.
 */
function ensureFtsTokenizer(d: SqlDatabase): void {
  const wanted = "tokenize = 'porter unicode61'";
  const rebuild: Array<[table: string, create: string, fill: string]> = [
    [
      "memory_decisions_fts",
      `CREATE VIRTUAL TABLE memory_decisions_fts USING fts5(id UNINDEXED, title, context, decision, rationale, how, consequences, touches, ${wanted})`,
      `INSERT INTO memory_decisions_fts (id, title, context, decision, rationale, how, consequences, touches)
         SELECT d.id, d.title, d.context, d.decision, d.rationale, d.how, d.consequences,
                COALESCE((SELECT group_concat(t.ref, ' ') FROM memory_touches t WHERE t.decision_id = d.id), '')
           FROM memory_decisions d`,
    ],
    [
      "memory_features_fts",
      `CREATE VIRTUAL TABLE memory_features_fts USING fts5(id UNINDEXED, name, aliases, summary, ${wanted})`,
      `INSERT INTO memory_features_fts (id, name, aliases, summary)
         SELECT id, name, REPLACE(REPLACE(REPLACE(aliases_json, '["', ''), '"]', ''), '","', ' '), summary FROM memory_features`,
    ],
  ];
  for (const [table, create, fill] of rebuild) {
    const row = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
    if (!row || row.sql.includes("porter")) continue;
    d.exec(`DROP TABLE ${table}`);
    d.exec(create);
    d.exec(fill);
  }
}


/** Columns added after the first schema; applied idempotently on open. */
const COLUMN_MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ["usage", "cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0"],
  ["usage", "cache_creation_tokens", "cache_creation_tokens INTEGER NOT NULL DEFAULT 0"],
  ["usage", "session_id", "session_id TEXT"],
  ["sessions", "base_tier", "base_tier TEXT"],
  ["sessions", "effort", "effort TEXT"],
  ["workflow_executions", "workspace_json", "workspace_json TEXT"],
  ["workflow_execution_steps", "tool_calls_json", "tool_calls_json TEXT"],
  ["workflow_executions", "quota_json", "quota_json TEXT"],
  ["workflow_executions", "resumed_from", "resumed_from TEXT"],
  ["usage", "account_id", "account_id TEXT"],
  ["usage", "provider_id", "provider_id TEXT"],
  ["traffic", "account_id", "account_id TEXT"],
  // An endpoint that serves no /models list (Z.AI's Anthropic endpoint among
  // them) names its catalogue here instead of being discovered.
  ["providers", "models_json", "models_json TEXT"],
  // Multi-user: a key belongs to a person, and a person to a team. Legacy keys
  // carry NULL and are read as the default team's.
  ["apikeys", "user_id", "user_id TEXT"],
  ["apikeys", "team_id", "team_id TEXT"],
  ["apikeys", "last_host", "last_host TEXT"],
  // What a key may reach: "gateway" (model calls) and/or "workflows" (the
  // client API that hands out definitions and takes run reports).
  ["apikeys", "scopes", "scopes TEXT NOT NULL DEFAULT 'gateway,workflows'"],
  // Runs that happened on someone's own machine: who, where, and still alive?
  ["workflow_executions", "user_id", "user_id TEXT"],
  ["workflow_executions", "team_id", "team_id TEXT"],
  ["workflow_executions", "origin", "origin TEXT NOT NULL DEFAULT 'server'"],
  ["workflow_executions", "client_host", "client_host TEXT"],
  ["workflow_executions", "client_repo", "client_repo TEXT"],
  ["workflow_executions", "client_branch", "client_branch TEXT"],
  ["workflow_executions", "last_seen_at", "last_seen_at INTEGER"],
  ["workflow_executions", "cancel_requested", "cancel_requested INTEGER NOT NULL DEFAULT 0"],
  // The worktree is on the client, so the diff it produced is uploaded here.
  ["workflow_executions", "diff_text", "diff_text TEXT"],
  // How the run is driven: "engine" is a process looping over the graph and
  // heartbeating every few seconds; "session" is a Claude Code session doing
  // one node at a time, which reports only at node boundaries.
  ["workflow_executions", "driver", "driver TEXT NOT NULL DEFAULT 'engine'"],
  // A session-driven run waiting on the person: since when, and how long it
  // has waited so far over the whole run. The run's clock leaves both out.
  ["workflow_executions", "paused_at", "paused_at INTEGER"],
  ["workflow_executions", "paused_ms", "paused_ms INTEGER NOT NULL DEFAULT 0"],
  // The Claude Code session driving a session-driven run. Its own model
  // calls reach the gateway under this id, which is how the nodes the
  // session does itself get a cost against the run.
  ["workflow_executions", "client_session", "client_session TEXT"],
  // A step's cost when it was worked out exactly (a session's calls across
  // several models), and where its usage came from: NULL/"reported" for the
  // node's own executor, "session" for an attribution from gateway traffic.
  ["workflow_execution_steps", "cost_usd", "cost_usd REAL"],
  ["workflow_execution_steps", "usage_source", "usage_source TEXT"],
  // A library held at one commit: sync fetches, but checks this out rather
  // than the remote's head, so the prompts written against a skill's text
  // keep meeting that text until somebody moves the pin.
  ["skill_sources", "pinned_sha", "pinned_sha TEXT"],
  // Teams nest: android and desktop under ulak. The tree is the boundary of
  // what a team's runs may read from memory — a sibling's feature record is
  // visible, another company's is not. NULL is a root.
  ["teams", "parent_id", "parent_id TEXT"],
];

let db: SqlDatabase | null = null;

export function getDb(): SqlDatabase {
  if (db) return db;
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite") as {
    DatabaseSync: new (path: string) => SqlDatabase;
  };
  const d = new DatabaseSync(join(GATE_DIR, "gate.db"));
  d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
  d.exec(SCHEMA);
  for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
    const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  d.exec("CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id)");
  ensureFtsTokenizer(d);
  db = d;
  importLegacyFiles(d);
  return d;
}

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? (row.value as string) : null;
}

export function kvSet(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/** One-time import of the pre-SQLite JSON/JSONL files, then rename them. */
function importLegacyFiles(d: SqlDatabase): void {
  const usageFile = join(GATE_DIR, "usage.jsonl");
  if (existsSync(usageFile) && d.prepare("SELECT COUNT(*) AS n FROM usage").get().n === 0) {
    try {
      const ins = d.prepare(
        "INSERT INTO usage (ts,requested,model,tier,reason,status,stream,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const line of readFileSync(usageFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          ins.run(e.ts, e.requested ?? null, e.model, e.tier, e.reason ?? null, e.status ?? null, e.stream ? 1 : 0, e.inputTokens ?? 0, e.outputTokens ?? 0);
        } catch {
          // skip malformed line
        }
      }
      renameSync(usageFile, usageFile + ".migrated");
    } catch {
      // best-effort
    }
  }

  const trafficFile = join(GATE_DIR, "traffic.jsonl");
  if (existsSync(trafficFile) && d.prepare("SELECT COUNT(*) AS n FROM traffic").get().n === 0) {
    try {
      const ins = d.prepare(
        "INSERT INTO traffic (ts,endpoint,requested,routed,tier,status,stream,from_cache,request_preview,response_preview) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (const line of readFileSync(trafficFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          ins.run(e.ts, e.endpoint ?? null, e.requested ?? null, e.routed ?? null, e.tier ?? null, e.status ?? null, e.stream ? 1 : 0, e.fromCache ? 1 : 0, e.requestPreview ?? "", e.responsePreview ?? "");
        } catch {
          // skip
        }
      }
      renameSync(trafficFile, trafficFile + ".migrated");
    } catch {
      // best-effort
    }
  }

  const keysFile = join(GATE_DIR, "apikeys.json");
  if (existsSync(keysFile) && d.prepare("SELECT COUNT(*) AS n FROM apikeys").get().n === 0) {
    try {
      const keys = JSON.parse(readFileSync(keysFile, "utf8")) as any[];
      const ins = d.prepare(
        "INSERT OR IGNORE INTO apikeys (id,name,hash,prefix,created_at,last_used_at,revoked) VALUES (?,?,?,?,?,?,?)",
      );
      for (const k of keys) ins.run(k.id, k.name, k.hash, k.prefix, k.createdAt, k.lastUsedAt ?? null, k.revoked ? 1 : 0);
      renameSync(keysFile, keysFile + ".migrated");
    } catch {
      // best-effort
    }
  }

  for (const f of ["cache.json", "ratelimit.json"]) {
    const p = join(GATE_DIR, f);
    if (existsSync(p)) {
      try {
        renameSync(p, p + ".migrated");
      } catch {
        // ignore
      }
    }
  }
}
