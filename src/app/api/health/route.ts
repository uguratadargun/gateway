import { NextResponse } from "next/server";

import { listAccounts, loadAccountCredentials } from "@/lib/accounts";
import { isCoolingDown } from "@/lib/account-pool";
import { forceRefresh, getValidCredentials } from "@/lib/token-manager";

export const runtime = "nodejs";

/** Token health per connected account: expiry, validity, pool availability. */
export async function GET() {
  const accounts = listAccounts();
  if (accounts.length === 0) return NextResponse.json({ connected: false, accounts: [] });

  const now = Date.now();
  const rows = accounts.map((a) => {
    const creds = loadAccountCredentials(a.id);
    const msLeft = creds ? creds.expiresAt - now : 0;
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      coolingDown: isCoolingDown(a, now),
      expiresAt: creds?.expiresAt ?? null,
      secondsLeft: creds ? Math.round(msLeft / 1000) : null,
      // A readable token whose access half has lapsed still refreshes; only an
      // unreadable blob (sealed under a different GATE_SECRET) is unhealthy.
      healthy: !!creds,
      updatedAt: creds?.updatedAt ?? null,
    };
  });

  const primary = rows.find((r) => r.enabled) ?? rows[0];
  return NextResponse.json({
    connected: true,
    expiresAt: primary.expiresAt,
    secondsLeft: primary.secondsLeft,
    healthy: rows.some((r) => r.healthy && r.enabled),
    updatedAt: primary.updatedAt,
    accounts: rows,
  });
}

/** Force a token refresh on the highest-priority account. */
export async function POST() {
  const refreshed = await forceRefresh();
  if (refreshed) return NextResponse.json({ ok: true, expiresAt: refreshed.expiresAt });
  // Fall back to a validity check — the refresh may have been unnecessary.
  const valid = await getValidCredentials();
  return NextResponse.json({ ok: !!valid, expiresAt: valid?.expiresAt ?? null });
}
