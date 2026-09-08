import { NextResponse } from "next/server";

import { listAccounts } from "@/lib/accounts";
import { isCoolingDown, quotaBlockedWindow, utilizationOf } from "@/lib/account-pool";
import { refreshUnpolledQuotas } from "@/lib/claude/usage";
import { loadSettings } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * The connected Claude accounts, with the pool state that explains why one is
 * or is not currently serving traffic. No token material is included.
 */
export async function GET() {
  const settings = loadSettings();
  // A just-connected account has served no traffic, so no unified rate-limit
  // header has ever described it — ask Claude's usage endpoint once so the
  // operator sees a bar rather than a blank. Keeping *only* that case in the
  // request path is deliberate: periodic refresh is the daemon's job, so a
  // dashboard left open never turns into a poll loop.
  await refreshUnpolledQuotas();
  const now = Date.now();
  const accounts = listAccounts().map((a) => ({
    ...a,
    coolingDown: isCoolingDown(a, now),
    quotaBlockedWindow: quotaBlockedWindow(a, settings.accountPool, now),
    utilization: utilizationOf(a, now),
  }));
  return NextResponse.json({ accounts, strategy: settings.accountPool });
}
