import { NextResponse } from "next/server";

import { addAccount } from "@/lib/accounts";
import { exchangeToken, fetchAccount } from "@/lib/claude/oauth";
import { clearPending, loadPending } from "@/lib/pkce-session";
import { createAccountSchema } from "@/lib/schemas";
import { newCliUserID, type StoredCredentials } from "@/lib/store";

export const runtime = "nodejs";

/**
 * Complete a login: exchange the pasted `code#state` for tokens and add the
 * account to the pool. Re-authorizing an account already in the pool refreshes
 * it in place rather than adding a duplicate.
 */
export async function POST(req: Request) {
  const parsed = createAccountSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  const pending = loadPending();
  if (!pending) {
    return NextResponse.json({ error: "No login in progress. Start again." }, { status: 400 });
  }

  try {
    const tokens = await exchangeToken(parsed.data.code, pending.verifier, pending.state);
    const account = await fetchAccount(tokens.access_token);
    const creds: StoredCredentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      account,
      // Each login gets its own Claude Code device_id, so one machine's
      // accounts cannot be correlated with each other upstream.
      cliUserID: newCliUserID(),
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const added = addAccount(creds, parsed.data.label);
    clearPending();
    return NextResponse.json({ ok: true, account: added });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token exchange failed" },
      { status: 502 },
    );
  }
}
