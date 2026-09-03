import { NextResponse } from "next/server";

import { fetchAvailableModels } from "@/lib/models";

export const runtime = "nodejs";

/** Models available on the connected account (live from Anthropic, cached). */
export async function GET() {
  return NextResponse.json(await fetchAvailableModels());
}
