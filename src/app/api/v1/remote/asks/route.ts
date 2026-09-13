import { NextResponse } from "next/server";

import { requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

/** The questions and approvals the caller's sessions are holding for them. */
export async function GET(req: Request) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ pending: remoteManager().pending(auth.principal) });
}
