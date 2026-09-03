import { getDb } from "./db";

/**
 * Local request/response traffic log for debugging the gateway. Bodies are
 * truncated. Stays on disk locally; never leaves the machine.
 */

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
      "INSERT INTO traffic (ts,endpoint,requested,routed,tier,status,stream,from_cache,request_preview,response_preview) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(e.ts, e.endpoint, e.requested, e.routed, e.tier, e.status, e.stream ? 1 : 0, e.fromCache ? 1 : 0, e.requestPreview, e.responsePreview);
    // Bound the table; cheap because of the ts index.
    db.prepare(
      "DELETE FROM traffic WHERE id NOT IN (SELECT id FROM traffic ORDER BY ts DESC LIMIT ?)",
    ).run(MAX_ROWS);
  } catch {
    // best-effort
  }
}

export function readTraffic(limit = 100): TrafficEntry[] {
  return (
    getDb()
      .prepare(
        "SELECT ts,endpoint,requested,routed,tier,status,stream,from_cache,request_preview,response_preview FROM traffic ORDER BY ts DESC LIMIT ?",
      )
      .all(limit) as any[]
  ).map((r) => ({
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
  }));
}

export function clearTraffic(): void {
  getDb().exec("DELETE FROM traffic");
}
