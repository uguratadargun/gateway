import { NextResponse } from "next/server";

import { clearTraffic, readTraffic } from "@/lib/traffic";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ entries: readTraffic(100) });
}

export async function DELETE() {
  clearTraffic();
  return NextResponse.json({ ok: true });
}
