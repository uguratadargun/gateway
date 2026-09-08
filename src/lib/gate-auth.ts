import { ALL_SCOPES, hasActiveKeys, resolveKey, type Principal } from "./apikeys";
import { DEFAULT_TEAM_ID } from "./teams";

/** The bearer token on a request, from either header form clients use. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

/**
 * The caller behind a gateway request: an issued key (if any exist), the
 * GATE_API_KEY env, or — when neither is configured — nobody in particular,
 * which is what a localhost-only install has always been. The last two cases
 * have no person attached, so they answer as the default team.
 */
export function gatePrincipal(req: Request): Principal | null {
  const token = bearerToken(req);
  if (hasActiveKeys()) {
    const principal = resolveKey(token, req.headers.get("x-gate-host"));
    return principal?.scopes.includes("gateway") ? principal : null;
  }
  const required = process.env.GATE_API_KEY;
  if (required && token !== required) return null;
  return { keyId: "local", userId: null, teamId: DEFAULT_TEAM_ID, scopes: [...ALL_SCOPES] };
}

/** Auth: an issued gate key (if any exist) or the GATE_API_KEY env, else open. */
export function gateAuthOk(req: Request): boolean {
  return gatePrincipal(req) !== null;
}
