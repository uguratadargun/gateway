import { callerLabel, servedByLabel } from "./attribution";
import { getDb } from "./db";

/**
 * Local request/response traffic log for debugging the gateway. Bodies are
 * truncated. Stays on disk locally; never leaves the machine.
 */

/** What a served request writes: ids only, resolved to names when read. */
export interface TrafficEntry {
  ts: number;
  endpoint: string; // "messages" | "chat/completions"
  requested: string;
  routed: string;
  tier: string;
  status: number;
  stream: boolean;
  fromCache: boolean;
  requestPreview: string;
  responsePreview: string;
  /** Which connected Claude account served it; null for a provider model. */
  accountId?: string | null;
  /** Which provider served it; null when a Claude account did. */
  providerId?: string | null;
  /** The key that resolved for the caller, the person behind it, their team. */
  keyId?: string | null;
  userId?: string | null;
  teamId?: string | null;
  /** This exchange's own id, for a copyable link straight to one row. */
  requestId: string;
  /** The run this request was made for, when it was one. Null on a call gate made for itself outside any run, and on any row written before this column existed. */
  executionId?: string | null;
}

/** What the page reads: the row, plus the names those ids resolve to. */
export interface TrafficRow extends TrafficEntry {
  /** The person behind the key, falling back to the key, then to "unknown". */
  caller: string;
  /** The account that served it, else the provider that did. Never empty. */
  servedBy: string;
  team: string;
  /** The workflow this row's run belongs to; null when there is no run. */
  workflowId: string | null;
  /** The step open when this row's request happened; null when none resolved
   *  (no run, or the run's step had not finished yet when the request was made). */
  nodeId: string | null;
}

/** What the filter bar reads: every value a filter could narrow to, computed
 *  over the whole table so an option never disappears as the filter narrows. */
export interface TrafficFacets {
  /** value is "user:<id>" or "key:<id>"; label is the same ladder the rows use. */
  people: Array<{ value: string; label: string }>;
  /** value is "account:<id>" or "provider:<id>". */
  served: Array<{ value: string; label: string }>;
  tiers: string[];
}

/** What `readTraffic` narrows by. Every field is optional; no field narrows
 *  at all. */
export interface TrafficQuery {
  /** Default 100, clamped to 1..the retention cap. */
  limit?: number;
  /** "user:<id>" or "key:<id>" — the person, or the key when there is no person. */
  person?: string | null;
  /** "account:<id>" or "provider:<id>" — whichever answered. */
  served?: string | null;
  tier?: string | null;
  requestId?: string | null;
}

const MAX_PREVIEW = 2000;
const MAX_ROWS = 500;

export function truncatePreview(s: string): string {
  return s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}…[+${s.length - MAX_PREVIEW}]` : s;
}

export function recordTraffic(e: TrafficEntry): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO traffic (ts,endpoint,requested,routed,tier,status,stream,from_cache,request_preview,response_preview,account_id,provider_id,key_id,user_id,team_id,request_id,execution_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      e.ts,
      e.endpoint,
      e.requested,
      e.routed,
      e.tier,
      e.status,
      e.stream ? 1 : 0,
      e.fromCache ? 1 : 0,
      e.requestPreview,
      e.responsePreview,
      e.accountId ?? null,
      e.providerId ?? null,
      e.keyId ?? null,
      e.userId ?? null,
      e.teamId ?? null,
      e.requestId,
      e.executionId ?? null,
    );
    // Bound the table; cheap because of the ts index.
    db.prepare(
      "DELETE FROM traffic WHERE id NOT IN (SELECT id FROM traffic ORDER BY ts DESC LIMIT ?)",
    ).run(MAX_ROWS);
  } catch {
    // best-effort
  }
}

/** "user:<id>" / "key:<id>" -> the column and value to match, or a condition
 *  that matches nothing for anything else — the API rejects an unrecognised
 *  prefix before it gets here (Task 4); this is the fallback if it does not. */
function personCondition(person: string): [sql: string, params: string[]] {
  if (person.startsWith("user:")) return ["t.user_id = ?", [person.slice("user:".length)]];
  if (person.startsWith("key:")) return ["t.key_id = ?", [person.slice("key:".length)]];
  return ["1 = 0", []];
}

/** "account:<id>" / "provider:<id>" — the same shape as `personCondition`. */
function servedCondition(served: string): [sql: string, params: string[]] {
  if (served.startsWith("account:")) return ["t.account_id = ?", [served.slice("account:".length)]];
  if (served.startsWith("provider:")) return ["t.provider_id = ?", [served.slice("provider:".length)]];
  return ["1 = 0", []];
}

export function readTraffic(q: TrafficQuery = {}): TrafficRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.person) {
    const [sql, ps] = personCondition(q.person);
    conditions.push(sql);
    params.push(...ps);
  }
  if (q.served) {
    const [sql, ps] = servedCondition(q.served);
    conditions.push(sql);
    params.push(...ps);
  }
  if (q.tier) {
    conditions.push("t.tier = ?");
    params.push(q.tier);
  }
  if (q.requestId) {
    conditions.push("t.request_id = ?");
    params.push(q.requestId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = q.limit ?? 100;

  // One join rather than five lookups: a deleted account, person or team yields
  // NULL by construction, which is exactly what the labels above degrade to.
  // The execution join and the node subquery are the same idea applied to a
  // run: a row whose run or step is gone still reads, just with less on it.
  const rows = getDb()
    .prepare(
      `SELECT t.ts, t.endpoint, t.requested, t.routed, t.tier, t.status, t.stream,
              t.from_cache, t.request_preview, t.response_preview,
              t.account_id, t.provider_id, t.key_id, t.user_id, t.team_id,
              t.request_id, t.execution_id,
              a.label AS account_label, p.label AS provider_label,
              u.name AS user_name, u.email AS user_email,
              k.name AS key_name, m.name AS team_name,
              x.workflow_id AS workflow_id,
              (SELECT s.node_id FROM workflow_execution_steps s
                WHERE s.execution_id = t.execution_id
                  AND t.ts BETWEEN s.started_at AND s.finished_at
                ORDER BY s.step_index DESC LIMIT 1) AS node_id
         FROM traffic t
         LEFT JOIN accounts  a ON a.id = t.account_id
         LEFT JOIN providers p ON p.id = t.provider_id
         LEFT JOIN users     u ON u.id = t.user_id
         LEFT JOIN apikeys   k ON k.id = t.key_id
         LEFT JOIN teams     m ON m.id = t.team_id
         LEFT JOIN workflow_executions x ON x.id = t.execution_id
        ${where}
        ORDER BY t.ts DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  // This key order is the CSV header of /api/export?what=traffic — append,
  // never reorder, and set every key on every row: the header is read off the
  // first one. requestId and executionId were appended after the original
  // eighteen; workflowId and nodeId after those.
  return rows.map((r) => ({
    ts: Number(r.ts),
    endpoint: r.endpoint ?? "",
    requested: r.requested ?? "",
    routed: r.routed ?? "",
    tier: r.tier ?? "",
    status: Number(r.status),
    stream: !!r.stream,
    fromCache: !!r.from_cache,
    requestPreview: r.request_preview ?? "",
    responsePreview: r.response_preview ?? "",
    accountId: r.account_id ?? null,
    providerId: r.provider_id ?? null,
    keyId: r.key_id ?? null,
    userId: r.user_id ?? null,
    teamId: r.team_id ?? null,
    caller: callerLabel(r),
    servedBy: servedByLabel(r),
    team: r.team_name ?? r.team_id ?? "",
    requestId: r.request_id ?? "",
    executionId: r.execution_id ?? null,
    workflowId: r.workflow_id ?? null,
    nodeId: r.node_id ?? null,
  }));
}

/** Every value a filter could narrow to, computed over the whole table. */
export function trafficFacets(): TrafficFacets {
  const db = getDb();

  const peopleRows = db
    .prepare(
      `SELECT DISTINCT t.user_id, t.key_id, u.name AS user_name, u.email AS user_email, k.name AS key_name
         FROM traffic t
         LEFT JOIN users   u ON u.id = t.user_id
         LEFT JOIN apikeys k ON k.id = t.key_id
        WHERE t.user_id IS NOT NULL OR t.key_id IS NOT NULL`,
    )
    .all() as any[];
  const people = new Map<string, string>();
  for (const r of peopleRows) {
    const value = r.user_id ? `user:${r.user_id}` : `key:${r.key_id}`;
    if (!people.has(value)) people.set(value, callerLabel(r));
  }

  const servedRows = db
    .prepare(
      `SELECT DISTINCT t.account_id, t.provider_id, a.label AS account_label, p.label AS provider_label
         FROM traffic t
         LEFT JOIN accounts  a ON a.id = t.account_id
         LEFT JOIN providers p ON p.id = t.provider_id
        WHERE t.account_id IS NOT NULL OR t.provider_id IS NOT NULL`,
    )
    .all() as any[];
  const served = new Map<string, string>();
  for (const r of servedRows) {
    const value = r.account_id ? `account:${r.account_id}` : `provider:${r.provider_id}`;
    if (!served.has(value)) served.set(value, servedByLabel(r));
  }

  const tierRows = db
    .prepare(`SELECT DISTINCT tier FROM traffic WHERE tier IS NOT NULL AND tier <> '' ORDER BY tier`)
    .all() as Array<{ tier: string }>;

  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return {
    people: [...people.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
    served: [...served.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
    tiers: tierRows.map((r) => r.tier),
  };
}

export function clearTraffic(): void {
  getDb().exec("DELETE FROM traffic");
}
