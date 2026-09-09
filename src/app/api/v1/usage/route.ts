import { NextResponse } from "next/server";

import { poolQuota } from "@/lib/account-pool";
import { listAccounts } from "@/lib/accounts";
import { refreshUnpolledQuotas } from "@/lib/claude/usage";
import { loadSettings } from "@/lib/settings";
import { requireClient } from "@/lib/tenancy";

export const runtime = "nodejs";

/**
 * What the pool has left, for a client that is on the gateway.
 *
 * Claude Code's own `/usage` is gone the moment a session joins gate: it reads
 * Anthropic's usage endpoint with the OAuth scopes of a subscription login, and
 * a session pointed at a gateway authenticates with an API key instead — so the
 * command hides itself and the person loses the one number that tells them
 * whether they can keep working. Gate knows the same windows, from the accounts
 * it rotates, and this is where it says so.
 *
 * The pool's numbers, not the caller's: what stops a session is the quota of
 * the account serving it, which is shared by everyone on this gate.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  // Only an account that has never been polled — the same rule the dashboard
  // follows. A window reading arrives free with every reply, so asking Claude's
  // separately rate-limited usage endpoint on each `gate usage` would spend a
  // budget that protects the thing being reported on.
  await refreshUnpolledQuotas();
  return NextResponse.json(poolQuota(listAccounts(), loadSettings().accountPool));
}
