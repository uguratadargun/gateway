import { NextResponse } from "next/server";

import { deleteAccount, listAccounts } from "@/lib/accounts";
import { resetRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Pool summary. `connected` and the identity fields describe the
 * highest-priority account, so pre-pool clients of this endpoint keep working;
 * `accounts` is the whole pool.
 */
export async function GET() {
  const accounts = listAccounts();
  const primary = accounts.find((a) => a.enabled) ?? accounts[0] ?? null;
  if (!primary) return NextResponse.json({ connected: false, count: 0, accounts: [] });
  return NextResponse.json({
    connected: true,
    count: accounts.length,
    email: primary.email,
    organization: primary.organization,
    tier: primary.planTier,
    plan: null,
    connectedAt: primary.connectedAt,
    accounts,
  });
}

/** Disconnect every account. One at a time: DELETE /api/accounts/<id>. */
export async function DELETE() {
  for (const account of listAccounts()) deleteAccount(account.id);
  // The snapshot describes an account gate no longer holds.
  resetRateLimit();
  return NextResponse.json({ ok: true });
}
