import { NextResponse } from "next/server";

import { clearCredentials, loadCredentials } from "@/lib/store";

export const runtime = "nodejs";

/** Current connection status for the dashboard. */
export async function GET() {
  const creds = loadCredentials();
  if (!creds) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: true,
    email: creds.account?.account_email ?? null,
    organization: creds.account?.organization_name ?? null,
    tier: creds.account?.organization_rate_limit_tier ?? null,
    plan: null,
    expiresAt: creds.expiresAt,
    connectedAt: creds.connectedAt,
    scopes: creds.scope ?? null,
  });
}

/** Disconnect the account. */
export async function DELETE() {
  clearCredentials();
  return NextResponse.json({ ok: true });
}
