import { ALL_SCOPES, hasActiveKeys, resolveKey, type Principal } from "./apikeys";
import { resolveRunToken } from "./run-tokens";
import { DEFAULT_TEAM_ID } from "./teams";

/**
 * The two key ids that belong to no issued key. Both are safe against a real
 * one: `createKey` mints sixteen hex characters.
 */
export const LOCAL_KEY_ID = "local";
export const INTERNAL_KEY_ID = "workflow";

/** The bearer token on a request, from either header form clients use. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

/**
 * The caller behind a gateway request: a run this process is holding, an issued
 * key (if any exist), the GATE_API_KEY env, or — when none of those is
 * configured — nobody in particular, which is what a localhost-only install has
 * always been. The last two cases have no person attached, so they answer as
 * the default team.
 */
export function gatePrincipal(req: Request): Principal | null {
  const token = bearerToken(req);
  // A run this process is holding right now, answering as the person and team
  // it is for. First, because a run token is not an issued key: on a gate that
  // has issued any it would be refused below, and where GATE_API_KEY is set it
  // would fail the equality.
  const run = token ? resolveRunToken(token) : null;
  if (run) return run;
  if (hasActiveKeys()) {
    const principal = resolveKey(token, req.headers.get("x-gate-host"));
    return principal?.scopes.includes("gateway") ? principal : null;
  }
  const required = process.env.GATE_API_KEY;
  if (required && token !== required) return null;
  return { keyId: LOCAL_KEY_ID, userId: null, teamId: DEFAULT_TEAM_ID, scopes: [...ALL_SCOPES] };
}

/** Auth: an issued gate key (if any exist) or the GATE_API_KEY env, else open. */
export function gateAuthOk(req: Request): boolean {
  return gatePrincipal(req) !== null;
}
