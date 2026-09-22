import { getDb } from "./db";
import { INTERNAL_KEY_ID, LOCAL_KEY_ID } from "./gate-auth";
import { loadSettings } from "./settings";

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
}

/** What the page reads: the row, plus the names those ids resolve to. */
export interface TrafficRow extends TrafficEntry {
  /** The person behind the key, falling back to the key, then to "unknown". */
  caller: string;
  /** The account that served it, else the provider that did. Never empty. */
  servedBy: string;
  team: string;
  /** The table's own autoincrement id. Part of the (ts, id) paging cursor,
   *  and the page's React key and expanded-row identity. Last on purpose:
   *  this key order is the CSV header of `/api/export?what=traffic` —
   *  append, never reorder. */
  id: number;
}

const MAX_PREVIEW = 2000;

export function truncatePreview(s: string): string {
  return s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}…[+${s.length - MAX_PREVIEW}]` : s;
}

/** Rows older than the retention window are gone. Returns how many went. */
export function pruneTraffic(now = Date.now()): number {
  const days = loadSettings().traffic.retentionDays;
  const cutoff = now - days * 86_400_000;
  return Number(getDb().prepare("DELETE FROM traffic WHERE ts < ?").run(cutoff).changes);
}

/** The position of a row in the (ts, id) order, opaque to the client. */
export function trafficCursor(row: { ts: number; id: number }): string {
  return `${row.ts}:${row.id}`;
}

/** null for no cursor; throws nothing — an unparseable cursor is undefined. */
export function parseTrafficCursor(s: string | null | undefined): { ts: number; id: number } | null {
  if (!s) return null;
  const m = /^(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  return { ts: Number(m[1]), id: Number(m[2]) };
}

export function recordTraffic(e: TrafficEntry): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO traffic (ts,endpoint,requested,routed,tier,status,stream,from_cache,request_preview,response_preview,account_id,provider_id,key_id,user_id,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
    );
    // The window is the only bound now; the indexed ts range delete is
    // strictly cheaper than sorting the whole table on every insert.
    pruneTraffic();
  } catch {
    // best-effort
  }
}

/** The person behind the key, named as /team names them. */
function callerLabel(r: any): string {
  if (r.user_name) return r.user_name;
  if (r.user_email) return r.user_email; // a person with no name set
  if (r.key_name) return r.key_name; // a key with no owner
  if (r.key_id === LOCAL_KEY_ID) return "local";
  if (r.key_id === INTERNAL_KEY_ID) return "workflow";
  if (r.key_id) return `key ${r.key_id}`; // the key went with its owner
  return "unknown"; // written before the log named its callers
}

/** Never meaningless: the Claude account, else the provider that answered. */
function servedByLabel(r: any): string {
  if (r.account_label) return r.account_label;
  if (r.account_id) return `removed account ${String(r.account_id).slice(0, 8)}`;
  if (r.provider_label) return r.provider_label;
  if (r.provider_id) return `removed provider ${String(r.provider_id).slice(0, 8)}`;
  return "—";
}

/** Newest first. `before` is a cursor from `trafficCursor`; it does not prune. */
export function readTraffic(limit = 100, before?: { ts: number; id: number } | null): TrafficRow[] {
  // One join rather than five lookups: a deleted account, person or team yields
  // NULL by construction, which is exactly what the labels above degrade to.
  // The (ts, id) predicate is exact where ts alone is not: ts is a millisecond
  // epoch and not unique, so a ts-only cursor either drops or repeats every
  // row sharing the boundary millisecond.
  const where = before ? "WHERE t.ts < ? OR (t.ts = ? AND t.id < ?)" : "";
  const params = before ? [before.ts, before.ts, before.id, limit] : [limit];
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.ts, t.endpoint, t.requested, t.routed, t.tier, t.status, t.stream,
              t.from_cache, t.request_preview, t.response_preview,
              t.account_id, t.provider_id, t.key_id, t.user_id, t.team_id,
              a.label AS account_label, p.label AS provider_label,
              u.name AS user_name, u.email AS user_email,
              k.name AS key_name, m.name AS team_name
         FROM traffic t
         LEFT JOIN accounts  a ON a.id = t.account_id
         LEFT JOIN providers p ON p.id = t.provider_id
         LEFT JOIN users     u ON u.id = t.user_id
         LEFT JOIN apikeys   k ON k.id = t.key_id
         LEFT JOIN teams     m ON m.id = t.team_id
        ${where}
        ORDER BY t.ts DESC, t.id DESC LIMIT ?`,
    )
    .all(...params) as any[];
  // This key order is the CSV header of /api/export?what=traffic — append,
  // never reorder, and set every key on every row: the header is read off the
  // first one.
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
    id: Number(r.id),
  }));
}

export function clearTraffic(): void {
  getDb().exec("DELETE FROM traffic");
}
