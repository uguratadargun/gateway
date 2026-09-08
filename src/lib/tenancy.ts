import { resolveKey, type Principal } from "./apikeys";
import { bearerToken } from "./gate-auth";
import { teamScope, type DefinitionScope } from "./def-root";
import { DEFAULT_TEAM_ID, ensureDefaultTeam, getTeam } from "./teams";

/**
 * Auth for the client API (`/api/v1/*`) — the surface the CLI on a developer's
 * machine talks to: it hands out a team's agent and workflow definitions and
 * takes back what their runs did.
 *
 * Unlike the gateway, this is never open. The gateway may run keyless because a
 * loopback-only install has nothing to protect from itself; this API is the one
 * people reach across the network, and an unauthenticated caller there would be
 * handed every workflow a team has written. `GATE_API_KEY` still works, for the
 * single-person install that has issued no keys, and answers as the default team.
 */

export interface ClientAuthError {
  status: number;
  error: string;
  code: string;
}

export function clientErrorResponse(e: ClientAuthError): Response {
  return new Response(JSON.stringify({ error: e.error, code: e.code }), {
    status: e.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The caller behind a client-API request, or the refusal to send back.
 *
 * Route handlers use it as `const auth = requireClient(req); if (auth instanceof Response) return auth;`
 * so the happy path reads as a plain principal.
 */
export function requireClient(req: Request): Principal | Response {
  const token = bearerToken(req);
  if (!token) {
    return clientErrorResponse({
      status: 401,
      error: "no API key — run `gate login --url <gate> --key <key>` first",
      code: "NO_API_KEY",
    });
  }

  const principal = resolveKey(token, req.headers.get("x-gate-host"));
  if (principal) {
    if (!principal.scopes.includes("workflows")) {
      return clientErrorResponse({
        status: 403,
        error: "this key is a gateway-only key; ask for one that may pull workflows",
        code: "SCOPE_MISSING",
      });
    }
    if (!getTeam(principal.teamId)) {
      return clientErrorResponse({
        status: 403,
        error: `this key's team ("${principal.teamId}") no longer exists`,
        code: "TEAM_GONE",
      });
    }
    return principal;
  }

  // The env key predates users; it is the whole of a single-person install.
  const envKey = process.env.GATE_API_KEY;
  if (envKey && token === envKey) {
    ensureDefaultTeam();
    return { keyId: "env", userId: null, teamId: DEFAULT_TEAM_ID, scopes: ["gateway", "workflows"] };
  }

  return clientErrorResponse({
    status: 401,
    error: "invalid or revoked API key",
    code: "INVALID_API_KEY",
  });
}

/** The definitions this caller may read: their team's. */
export function scopeForPrincipal(principal: Principal): DefinitionScope {
  return teamScope(principal.teamId);
}

/**
 * Whether a caller may report on, or read, a given run.
 *
 * Team membership is the boundary — a run is visible to the team whose
 * workflow produced it — and a run with an owner may only be reported on by
 * that owner. Two people on the same team can watch each other's runs in the
 * dashboard; neither can write steps into the other's.
 */
export function ownsExecution(
  execution: { teamId: string; userId: string | null },
  principal: Principal,
): boolean {
  if (execution.teamId !== principal.teamId) return false;
  if (execution.userId && execution.userId !== principal.userId) return false;
  return true;
}
