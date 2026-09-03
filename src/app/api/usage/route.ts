import { NextResponse } from "next/server";

import { readUsage } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(readUsage(50));
}
