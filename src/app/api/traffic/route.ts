import { NextResponse } from "next/server";

import { clearTraffic, readTraffic, trafficFacets, type TrafficQuery } from "@/lib/traffic";

export const runtime = "nodejs";

/** The four tiers a request can route to (src/lib/router.ts:17). */
const TIERS = new Set(["haiku", "sonnet", "opus", "fable"]);

/** Reads and validates the filters both `/api/traffic` and `/api/export`
 *  accept. A filter the caller asked for that silently matched everything
 *  would be worse than a refusal, so anything unrecognised is a 400 naming
 *  the parameter rather than a query that ignores it. */
export function parseTrafficFilters(url: URL): { query: TrafficQuery } | { error: string } {
  const person = url.searchParams.get("person");
  if (person && !/^(user|key):/.test(person)) return { error: "person" };

  const served = url.searchParams.get("served");
  if (served && !/^(account|provider):/.test(served)) return { error: "served" };

  const tier = url.searchParams.get("tier");
  if (tier && !TIERS.has(tier)) return { error: "tier" };

  const requestId = url.searchParams.get("request");

  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw != null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) return { error: "limit" };
    limit = n;
  }

  return { query: { person, served, tier, requestId, limit } };
}

export async function GET(req: Request) {
  const parsed = parseTrafficFilters(new URL(req.url));
  if ("error" in parsed) return NextResponse.json({ error: `invalid ${parsed.error}` }, { status: 400 });

  return NextResponse.json({ entries: readTraffic(parsed.query), facets: trafficFacets() });
}

export async function DELETE() {
  clearTraffic();
  return NextResponse.json({ ok: true });
}
