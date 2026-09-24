import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sessionTitle } from "./session-title";

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

-- A Telegram chat linked to a person: the bot answers their questions and
-- starts their runs from it, on a key minted for the link (sealed, because a
-- remote session runs on the plaintext). Unlinking revokes that key.
CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT,
  team_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  username TEXT,
  linked_at INTEGER NOT NULL
);

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
  -- How far the work got, and no further than the run proves: deployed and
  -- merged are live, pr-open means a merge request was opened and nobody
  -- watched it land, completed means the run finished but never offered the
  -- work for merge, unshipped means the branch never reached its merge
  -- request, abandoned means the run failed or was stopped — which says
  -- nothing about the idea; a refused approach is the verdict column. 'shipped' is what rows carried before the
  -- distinction existed and is left alone; nothing re-derives it.
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

-- Vectors, when an embedding provider is configured: one per feature and per
-- decision, as Float32 little-endian blobs, keyed by the model that made
-- them so a change of model re-embeds rather than compares apples to pears.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

-- The consolidation ledger: one row per pass over a team's implementation
-- of a feature, so what it cost and what it changed is on record.
CREATE TABLE IF NOT EXISTS memory_consolidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  decisions_read INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS memory_consolidations_impl ON memory_consolidations(feature_id, team_id, started_at);

-- A piece of work several teams have a hand in, outliving every run that
-- serves it. The runs are per team and per repo and they end; the thing they
-- are all about does not, so it gets an id of its own rather than being
-- inferred from whichever run happened to be first.
--
-- This is deliberately the smallest version of that record: an id, who owns
-- it, what it is called, and whether it is still going. The plan's per-team
-- pages, baselines, plan versions and work items are built on this id later;
-- they are not a precondition for a run being able to say which task it was
-- serving.
--
-- Nothing requires it. A single-repo run has no task and behaves exactly as
-- it did, so the column is a label, never a key: an objection is still found
-- by its paths and its feature, because the run that raised it may well have
-- been started by somebody who never opened a task.
CREATE TABLE IF NOT EXISTS change_tasks (
  id TEXT PRIMARY KEY,
  -- The team the task belongs to — normally the parent of the teams doing the
  -- work, which is why it may have no repo of its own.
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  -- open: still being worked. done/abandoned are ends. A task is not closed by
  -- a run finishing; somebody says so.
  status TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_tasks_team ON change_tasks(team_id, status, updated_at);

-- One run's objection to a sibling team's decision, and the person's answer to
-- it. Separate from memory_decisions on purpose: a re-extraction deletes a
-- run's decisions and writes new ids, and an objection that vanished with the
-- id it pointed at would take the whole point with it. The card id here is a
-- convenience link; the snapshot, the paths and the feature are what find it.
--
-- An objection is a *proposal*. It never writes valid_to on the decision it
-- disagrees with — one team closing another's record behind their back is the
-- thing this exists to replace.
CREATE TABLE IF NOT EXISTS decision_issues (
  id TEXT PRIMARY KEY,
  -- Where it was raised: the run, the step, and the node visit inside it.
  execution_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  source_node_id TEXT NOT NULL,
  source_visit INTEGER NOT NULL,
  -- Unique within the step, given by the node that raised it. This is what an
  -- approval names, so it never has to wait for a server-generated id.
  conflict_key TEXT NOT NULL,
  from_team_id TEXT NOT NULL,
  target_team_id TEXT NOT NULL,
  -- What it is about. decision_id is the helper link; it may go stale.
  decision_id TEXT,
  feature_id TEXT,
  paths_json TEXT NOT NULL DEFAULT '[]',
  -- The run's own workspace, kept as an open description until package 2 can
  -- resolve it to a canonical repo with evidence. Never guessed.
  repo_source TEXT,
  source_commit TEXT,
  title TEXT NOT NULL,
  decision_snapshot TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  proposal TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL DEFAULT '',
  -- proposed: raised, nobody has confirmed it. open: a person's answer was
  -- reported, so the target team is asked to look. resolved/withdrawn/rejected
  -- are ends. Only "open" and "proposed" reach the target team's recall.
  status TEXT NOT NULL,
  opened_by TEXT,
  resolution TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Twice-reported steps must not make a second objection, and one (node, visit)
-- must mean one thing: an approval that could match two rows is refused rather
-- than guessed at.
CREATE UNIQUE INDEX IF NOT EXISTS decision_issues_step ON decision_issues(execution_id, step_index, conflict_key);
CREATE UNIQUE INDEX IF NOT EXISTS decision_issues_source ON decision_issues(execution_id, source_node_id, source_visit, conflict_key);
CREATE INDEX IF NOT EXISTS decision_issues_target ON decision_issues(target_team_id, status);
CREATE INDEX IF NOT EXISTS decision_issues_decision ON decision_issues(decision_id);
CREATE INDEX IF NOT EXISTS decision_issues_feature ON decision_issues(feature_id);

-- The person's answer, kept whether or not the step it is about has arrived.
--
-- The client reports steps in batches and a batch can reach the server in any
-- order after a retry; rejecting the report until the source step turns up
-- would make RunReporter re-queue the whole batch, be refused again, and give
-- up — losing the very confirmation this table exists to keep. So the answer
-- is stored as pending_source and reconciled when the source arrives.
CREATE TABLE IF NOT EXISTS decision_issue_approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  visit INTEGER NOT NULL,
  source_node_id TEXT NOT NULL,
  source_visit INTEGER NOT NULL,
  conflict_key TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- pending_source: kept, waiting for the step it is about. applied: it moved
  -- an objection. rejected: it could not, and the reason column says why. Nothing here
  -- is ever deleted for having waited too long.
  status TEXT NOT NULL,
  reason TEXT,
  issue_id TEXT,
  -- Another answer already settled this objection, differently. Marked rather
  -- than overwritten: last write does not win a disagreement.
  conflicted INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_issue_approvals_key
  ON decision_issue_approvals(execution_id, step_index, source_node_id, source_visit, conflict_key);
CREATE INDEX IF NOT EXISTS decision_issue_approvals_pending
  ON decision_issue_approvals(status, execution_id, source_node_id, source_visit);

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

-- The record index: what each connected repository says about itself on its
-- base branch — design docs, decision records, specs, the map — read by code
-- from git, never by a model. Derived and rebuildable: dropping every row and
-- indexing again loses nothing, because the files are the source.
--
-- One row per repository: which commit of which ref was read, and when.
CREATE TABLE IF NOT EXISTS record_repos (
  repo TEXT PRIMARY KEY,           -- repos.id
  repo_id TEXT,                    -- host/owner/name, when known
  team_id TEXT,                    -- the team whose repository it is
  ref TEXT,
  commit_sha TEXT,
  committed_at INTEGER,
  indexed_at INTEGER,
  error TEXT,
  docs INTEGER NOT NULL DEFAULT 0,
  -- The last base-branch commit merges were looked at up to, for
  -- memory.recordMerges; NULL until the first index sets the watermark.
  merges_seen TEXT
);

-- One row per document on the base branch. \`blob\` is git's own hash of the
-- file, so an unchanged document is not read again.
CREATE TABLE IF NOT EXISTS record_docs (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  repo_id TEXT,
  team_id TEXT,
  kind TEXT NOT NULL,              -- design | decision | spec | architecture | note
  slug TEXT NOT NULL,              -- the file name without number or date
  number INTEGER,                  -- a decision record's NNNN
  title TEXT NOT NULL,
  status TEXT,                     -- accepted / superseded by NNNN / a spec's Status
  date TEXT,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  blob TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, path)
);
CREATE INDEX IF NOT EXISTS record_docs_kind_slug ON record_docs(kind, slug);

-- What a feature offers other repositories and what it uses from them, as
-- its design doc's Interfaces section says: an API, an event, a schema.
CREATE TABLE IF NOT EXISTS record_interfaces (
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  role TEXT NOT NULL,              -- provides | consumes
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo, path, role, name)
);
CREATE INDEX IF NOT EXISTS record_interfaces_name ON record_interfaces(name);

CREATE VIRTUAL TABLE IF NOT EXISTS record_docs_fts USING fts5(
  key UNINDEXED, title, summary, body, path, tokenize = 'porter unicode61'
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
  // Who called and who served. Ids, not labels: a label is editable and the row
  // it names can be deleted, so /traffic resolves them as it reads and says so
  // when it cannot. A row written before this release carries NULL throughout.
  ["traffic", "key_id", "key_id TEXT"],
  ["traffic", "user_id", "user_id TEXT"],
  ["traffic", "team_id", "team_id TEXT"],
  ["traffic", "provider_id", "provider_id TEXT"],
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
  // How many of the implementation's decisions the last consolidation read,
  // and when: the pass is due again once enough new ones have landed.
  ["memory_feature_impls", "consolidated_count", "consolidated_count INTEGER NOT NULL DEFAULT 0"],
  ["memory_feature_impls", "consolidated_at", "consolidated_at INTEGER"],
  // Which cross-team task a run was serving, and the same label copied onto
  // the objections it raised — copied rather than joined, because the run is
  // what knows, and an objection outlives re-extraction while the join would
  // have to be re-derived. NULL on every run started without one, which is
  // most of them.
  ["workflow_executions", "task_id", "task_id TEXT"],
  ["decision_issues", "task_id", "task_id TEXT"],
  // What makes two checkouts the same repository. `remote_url` is what the
  // checkout's origin actually said; `repo_id` is that normalised to
  // host/owner/name, and is NULL wherever the remote did not say — a local
  // clone, an ssh alias, a repo registered by path. Never guessed from the
  // path or the slug: two teams' repositories are routinely called the same
  // thing, and a shared identity merges their memory silently.
  ["repos", "remote_url", "remote_url TEXT"],
  ["repos", "repo_id", "repo_id TEXT"],
  // The same identity carried down the chain that a path travels: the run
  // that did the work, the decision it produced, and each file that decision
  // touched. A relative path is only meaningful next to the repository it is
  // relative to, and `memory_touches.ref` had nothing beside it — so
  // src/index.ts in the desktop app and src/index.ts on the server were one
  // key. Denormalised onto the touch rather than joined through the decision
  // because the path lookup is the hot one and has to filter in the index.
  //
  // NULL is unknown, and unknown is not evidence of difference: a query that
  // knows its repository hides decisions belonging to a *different* named
  // repository, and keeps the unnamed ones. Anything else would drop every
  // record made before identity existed.
  ["workflow_executions", "repo_id", "repo_id TEXT"],
  ["memory_decisions", "repo_id", "repo_id TEXT"],
  ["memory_touches", "repo_id", "repo_id TEXT"],
  ["decision_issues", "repo_id", "repo_id TEXT"],
  // Which team owns a repository, and where its work is published so another
  // team can read it. A branch that only exists in a worktree on somebody's
  // laptop cannot answer a question asked from another repository, and every
  // cross-team feature here ends in someone needing to read the work rather
  // than a summary of it.
  //
  // `publication_remote` is a remote name (or a URL) and NULL means this
  // repository does not publish — the default, so nothing starts pushing
  // because a column appeared. `branch_policy` bounds what may be pushed
  // when it does; NULL is read as `gate/*`, which is everything gate makes
  // and nothing a person is working on.
  ["repos", "team_id", "team_id TEXT"],
  ["repos", "publication_remote", "publication_remote TEXT"],
  ["repos", "branch_policy", "branch_policy TEXT"],
  // The last verified publication of a run's branch: the ref, the commit the
  // *remote* reported holding afterwards, and when. Separate from the run's
  // own commit because they answer different questions — "what did this run
  // build" and "what can another machine fetch" — and because publication is
  // allowed to fail without the run having failed, which is what
  // `publish_error` records instead of throwing the result away.
  ["workflow_executions", "published_ref", "published_ref TEXT"],
  ["workflow_executions", "published_commit", "published_commit TEXT"],
  ["workflow_executions", "published_at", "published_at INTEGER"],
  ["workflow_executions", "publish_error", "publish_error TEXT"],
  // The definitions this run is held to: the workflow's source and the source
  // of every agent it names, as they were when it started. A team editing an
  // agent an hour into a run must not change what that run's reports are
  // checked against, in either direction — so the check reads this and not
  // the files on disk. NULL on every run started before it existed, and those
  // are checked the way they always were rather than refused for lacking
  // evidence they were never asked for.
  ["workflow_executions", "definitions_json", "definitions_json TEXT"],
  // A model-scoped weekly limit that rejected a request parks the model on the
  // account, not the account in the pool. One JSON column: at most a handful of
  // entries, each the window's name, the scope it answered as, and the reset
  // time — a weekly window legitimately runs days out, which a cooldown column
  // could not say without taking the whole login with it.
  ["accounts", "model_blocks_json", "model_blocks_json TEXT"],
  // A traffic row's own id, for a copyable link straight to one exchange, and
  // the run it was made for, so a row can be traced back to the execution and
  // node that caused it. Both NULL on a row written before this release.
  ["traffic", "request_id", "request_id TEXT"],
  ["traffic", "execution_id", "execution_id TEXT"],
  // Whether an approach was refused, apart from whether the run that tried it
  // finished: a run stopped by a timeout or a person going home is not a
  // verdict on its idea, and reading it as one closed good roads.
  ["memory_decisions", "verdict", "verdict TEXT"],
  ["memory_decisions", "verdict_reason", "verdict_reason TEXT"],
  // The team whose run made a decision, when the decision belongs to another:
  // work in a repository is that repository's team's record, whoever did it.
  ["memory_decisions", "author_team_id", "author_team_id TEXT"],
  // The base-branch commit the record index checked the decision's files
  // against, and how many were gone — a decision about code that no longer
  // exists is said to be so rather than handed to a planner as current.
  ["memory_decisions", "checked_commit", "checked_commit TEXT"],
  ["memory_decisions", "missing_touches", "missing_touches INTEGER NOT NULL DEFAULT 0"],
  // A design doc's Pitfalls, kept apart from its Summary: what a sibling team
  // building the same feature must not miss, shown with the doc rather than
  // buried in its body. NULL on a row read before it was kept, which the
  // index reads again.
  ["record_docs", "pitfalls", "pitfalls TEXT"],
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
  // A path lookup now asks two questions at once — which file, and whose —
  // so the repository travels in the index rather than as a filter applied
  // to everything the path alone matched.
  d.exec("CREATE INDEX IF NOT EXISTS memory_touches_ref_repo ON memory_touches(ref, repo_id)");
  // Traffic: a point lookup for the request id a row shows, a join to the
  // execution it traces to, and one composite per filterable column — each
  // ordered (value, ts) because every filtered read is "this value, newest
  // first, limit N", which the composite serves without a sort left behind.
  d.exec("CREATE INDEX IF NOT EXISTS traffic_request_id ON traffic(request_id)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_execution_id ON traffic(execution_id)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_user_ts ON traffic(user_id, ts)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_key_ts ON traffic(key_id, ts)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_account_ts ON traffic(account_id, ts)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_provider_ts ON traffic(provider_id, ts)");
  d.exec("CREATE INDEX IF NOT EXISTS traffic_tier_ts ON traffic(tier, ts)");
  // For Task 3's node-resolution subquery: which step of a run was open when
  // a traffic row's timestamp fell.
  d.exec(
    "CREATE INDEX IF NOT EXISTS workflow_execution_steps_execution_started ON workflow_execution_steps(execution_id, started_at)",
  );
  ensureFtsTokenizer(d);
  retitleSessions(d);
  db = d;
  importLegacyFiles(d);
  return d;
}

/**
 * Sessions named before the title was the user's prompt hold whatever request
 * came first, cut at 80 characters. Once, the stored titles go through the
 * same reading; what has no prompt in it becomes NULL, which the session's
 * next request fills.
 */
function retitleSessions(d: SqlDatabase): void {
  // Renamed when the reading improves, so titles read by an earlier one are read again.
  const flag = "sessions_retitled_2";
  if (d.prepare("SELECT 1 FROM kv WHERE key = ?").get(flag)) return;
  const rows = d.prepare("SELECT id, title FROM sessions WHERE title IS NOT NULL").all() as Array<{ id: string; title: string }>;
  const upd = d.prepare("UPDATE sessions SET title = ? WHERE id = ?");
  for (const r of rows) {
    const t = sessionTitle(r.title);
    if (t !== r.title) upd.run(t, r.id);
  }
  d.prepare("INSERT INTO kv (key, value) VALUES (?, '1')").run(flag);
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
