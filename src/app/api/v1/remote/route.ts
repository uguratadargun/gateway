import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

/**
 * Whether this key can run sessions here, whether this server can host them,
 * and the repositories they can open in. Answered for any client key — a
 * cockpit asks before it offers the choice, and "not allowed" is something to
 * show, not an error.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json(remoteManager().info(auth));
}
