import { NextResponse } from "next/server";

import { loadCredentials } from "@/lib/store";
import { forceRefresh, getValidCredentials } from "@/lib/token-manager";

export const runtime = "nodejs";

/** Token health: expiry and validity. */
export async function GET() {
  const creds = loadCredentials();
  if (!creds) return NextResponse.json({ connected: false });
  const msLeft = creds.expiresAt - Date.now();
  return NextResponse.json({
    connected: true,
    expiresAt: creds.expiresAt,
    secondsLeft: Math.round(msLeft / 1000),
    healthy: msLeft > 0,
    updatedAt: creds.updatedAt,
  });
}

/** Force a token refresh now. */
export async function POST() {
  const refreshed = await forceRefresh();
  if (refreshed) return NextResponse.json({ ok: true, expiresAt: refreshed.expiresAt });
  // fall back to a validity check (refresh may have been unnecessary)
  const valid = await getValidCredentials();
  return NextResponse.json({ ok: !!valid, expiresAt: valid?.expiresAt ?? null });
}
