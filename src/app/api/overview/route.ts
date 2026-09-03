import { NextResponse } from "next/server";

import { checkBudget } from "@/lib/budget";
import { cacheStats } from "@/lib/cache";
import { readRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Aggregated live status: rate limit, budget, and cache — for the dashboard. */
export async function GET() {
  return NextResponse.json({
    rateLimit: readRateLimit(),
    budget: checkBudget(),
    cache: cacheStats(),
  });
}
