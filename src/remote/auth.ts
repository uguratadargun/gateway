import { NextResponse } from "next/server";

import type { Principal } from "@/lib/apikeys";
import { bearerToken } from "@/lib/gate-auth";
import { clientErrorResponse, requireClient } from "@/lib/tenancy";

import { RemoteError } from "./manager";

/**
 * Who may run sessions on the gate server.
 *
 * A remote session is an interactive terminal on this machine, running as
 * the user gate runs as — a different grant from pulling a team's workflows,
 * so it has its own scope, `remote`, issued deliberately like `author`. The
 * caller's key is handed back with the principal because the session runs on
 * it: its model calls and its `gate` CLI calls are that person's.
 */
export function requireRemote(req: Request): { principal: Principal; key: string } | Response {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  if (!auth.scopes.includes("remote")) {
    return clientErrorResponse({
      status: 403,
      error: "this key may not run sessions on the gate server — ask for a key with the remote scope on the Team page",
      code: "SCOPE_MISSING",
    });
  }
  return { principal: auth, key: bearerToken(req) };
}

/** A RemoteError in the client API's own error shape; anything else is rethrown. */
export function remoteErrorResponse(e: unknown): Response {
  if (e instanceof RemoteError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  throw e;
}
