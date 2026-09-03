import { NextResponse } from "next/server";

import { checkBudget } from "@/lib/budget";
import { cacheStats } from "@/lib/cache";
import { inflightCount } from "@/lib/inflight";
import { getLimiter } from "@/lib/limiter";
import { forecastRateLimit, readRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Aggregated live status for the dashboard. */
export async function GET() {
  return NextResponse.json({
    rateLimit: readRateLimit(),
    forecast: forecastRateLimit(),
    budget: checkBudget(),
    cache: cacheStats(),
    limiter: getLimiter().stats(),
    inflight: inflightCount(),
  });
}
