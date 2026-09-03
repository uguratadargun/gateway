import { NextResponse } from "next/server";

import { listSessions } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ sessions: listSessions(100) });
}
