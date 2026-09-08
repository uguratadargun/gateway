import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { getTeam, getUser } from "@/lib/teams";

export const runtime = "nodejs";

function gatewayUrlFor(req: Request): string {
  const url = new URL("/api/gateway", req.url);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

/** The smallest useful answer to "am I connected, and as whom". */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  const user = auth.userId ? getUser(auth.userId) : null;
  const team = getTeam(auth.teamId);
  return NextResponse.json({
    user: user ? { id: user.id, email: user.email, name: user.name } : null,
    team: team ? { id: team.id, name: team.name } : { id: auth.teamId, name: auth.teamId },
    scopes: auth.scopes,
    // Where the client points its model calls and its spawned Claude Code.
    // `localhost` is normalised the way /api/clients does it: it may resolve to
    // ::1 while the server binds 127.0.0.1.
    gatewayUrl: gatewayUrlFor(req),
  });
}
