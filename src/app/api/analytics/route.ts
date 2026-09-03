import { NextResponse } from "next/server";

import { getAnalytics, type AnalyticsRange } from "@/lib/usage";

export const runtime = "nodejs";

const RANGES = new Set<AnalyticsRange>(["24h", "7d", "30d"]);

export async function GET(req: Request) {
  const r = new URL(req.url).searchParams.get("range") ?? "24h";
  const range = (RANGES.has(r as AnalyticsRange) ? r : "24h") as AnalyticsRange;
  return NextResponse.json(getAnalytics(range));
}
