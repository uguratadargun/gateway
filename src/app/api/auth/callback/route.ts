import { NextResponse } from "next/server";

import { exchangeToken, fetchAccount } from "@/lib/claude/oauth";
import { clearPending, loadPending } from "@/lib/pkce-session";
import { newCliUserID, saveCredentials, type StoredCredentials } from "@/lib/store";

export const runtime = "nodejs";

/** Complete login: exchange the pasted `code#state` for tokens and persist. */
export async function POST(req: Request) {
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  const pending = loadPending();
  if (!pending) {
    return NextResponse.json({ error: "No login in progress. Start again." }, { status: 400 });
  }

  try {
    const tokens = await exchangeToken(code, pending.verifier, pending.state);
    const account = await fetchAccount(tokens.access_token);
    const creds: StoredCredentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      account,
      cliUserID: newCliUserID(),
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveCredentials(creds);
    clearPending();
    return NextResponse.json({
      ok: true,
      email: account?.account_email ?? null,
      organization: account?.organization_name ?? null,
      tier: account?.organization_rate_limit_tier ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token exchange failed" },
      { status: 502 },
    );
  }
}
