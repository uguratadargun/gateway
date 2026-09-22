import { NextResponse } from "next/server";

import { clearTraffic, parseTrafficCursor, readTraffic, trafficCursor } from "@/lib/traffic";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100));

  const rawBefore = url.searchParams.get("before");
  const before = parseTrafficCursor(rawBefore);
  // A cursor that is present but unparseable is refused rather than silently
  // treated as absent: a client asking for older rows and getting the newest
  // page back would duplicate rows it already holds.
  if (rawBefore != null && before == null) {
    return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  }

  const entries = readTraffic(limit, before);
  const nextCursor = entries.length < limit ? null : trafficCursor(entries[entries.length - 1]);
  return NextResponse.json({ entries, nextCursor });
}

export async function DELETE() {
  clearTraffic();
  return NextResponse.json({ ok: true });
}
