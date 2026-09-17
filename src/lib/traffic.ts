import { getDb } from "./db";
import { INTERNAL_KEY_ID, LOCAL_KEY_ID } from "./gate-auth";

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
    // Bound the table; cheap because of the ts index.
    db.prepare(
      "DELETE FROM traffic WHERE id NOT IN (SELECT id FROM traffic ORDER BY ts DESC LIMIT ?)",
    ).run(MAX_ROWS);
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

export function readTraffic(limit = 100): TrafficRow[] {
  // One join rather than five lookups: a deleted account, person or team yields
  // NULL by construction, which is exactly what the labels above degrade to.
  const rows = getDb()
    .prepare(
      `SELECT t.ts, t.endpoint, t.requested, t.routed, t.tier, t.status, t.stream,
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
        ORDER BY t.ts DESC LIMIT ?`,
    )
    .all(limit) as any[];
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
  }));
}

export function clearTraffic(): void {
  getDb().exec("DELETE FROM traffic");
}
