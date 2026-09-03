import {
  ANTHROPIC_BOOTSTRAP_URL,
  CLAUDE_CODE_VERSION,
  CLAUDE_OAUTH,
} from "./config";

export interface ClaudeTokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export interface ClaudeAccount {
  account_uuid: string | null;
  account_email: string | null;
  organization_uuid: string | null;
  organization_name: string | null;
  organization_type: string | null;
  organization_rate_limit_tier: string | null;
}

/**
 * Build the Claude Code authorization URL. `prompt=login` forces Anthropic's
 * IdP to re-authenticate rather than silently reuse a browser session.
 */
export function buildAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: CLAUDE_OAUTH.codeChallengeMethod,
    state,
    prompt: "login",
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens. The pasted code from Anthropic's
 * callback page is formatted `<code>#<state>`; split it if needed.
 */
export async function exchangeToken(
  rawCode: string,
  codeVerifier: string,
  expectedState: string,
): Promise<ClaudeTokenSet> {
  let code = rawCode.trim();
  let state = expectedState;
  if (code.includes("#")) {
    const [c, s] = code.split("#");
    code = c;
    if (s) state = s;
  }

  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      code,
      state,
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as ClaudeTokenSet;
}

/** Refresh an access token. Uses form-urlencoded per the OAuth2 spec. */
export async function refreshToken(refresh_token: string): Promise<ClaudeTokenSet | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: CLAUDE_OAUTH.clientId,
  });
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as ClaudeTokenSet;
  return { ...tokens, refresh_token: tokens.refresh_token || refresh_token };
}

/**
 * Best-effort fetch of the account/organization profile. Never throws — a
 * failure here must not block a valid token from being stored.
 */
export async function fetchAccount(accessToken: string): Promise<ClaudeAccount | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(ANTHROPIC_BOOTSTRAP_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { oauth_account?: Record<string, unknown> };
    const a = data?.oauth_account;
    if (!a || typeof a !== "object") return null;
    const s = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      account_uuid: s(a.account_uuid),
      account_email: s(a.account_email),
      organization_uuid: s(a.organization_uuid),
      organization_name: s(a.organization_name),
      organization_type: s(a.organization_type),
      organization_rate_limit_tier: s(a.organization_rate_limit_tier),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
