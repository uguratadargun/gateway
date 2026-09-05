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

CREATE TABLE IF NOT EXISTS workflow_layouts (
  workflow_id TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Columns added after the first schema; applied idempotently on open. */
const COLUMN_MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ["usage", "cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0"],
  ["usage", "cache_creation_tokens", "cache_creation_tokens INTEGER NOT NULL DEFAULT 0"],
  ["usage", "session_id", "session_id TEXT"],
  ["sessions", "base_tier", "base_tier TEXT"],
  ["sessions", "effort", "effort TEXT"],
  ["workflow_executions", "workspace_json", "workspace_json TEXT"],
  ["workflow_execution_steps", "tool_calls_json", "tool_calls_json TEXT"],
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
