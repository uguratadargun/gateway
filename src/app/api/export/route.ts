import { readTraffic } from "@/lib/traffic";
import { exportUsage } from "@/lib/usage";

export const runtime = "nodejs";

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/** Download usage or traffic as CSV/JSON. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const what = url.searchParams.get("what") === "traffic" ? "traffic" : "usage";
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const rows: Record<string, unknown>[] = what === "traffic" ? (readTraffic(500) as unknown as Record<string, unknown>[]) : exportUsage();
  const date = new Date().toISOString().slice(0, 10);
  const filename = `gate-${what}-${date}.${format}`;
  const body = format === "json" ? JSON.stringify(rows, null, 2) : toCsv(rows);
  return new Response(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
