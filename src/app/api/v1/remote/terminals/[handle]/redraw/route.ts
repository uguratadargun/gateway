import { NextResponse } from "next/server";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ handle: string }> };

/** Asks the TUI for a fresh frame, for a terminal a cockpit has only just attached. */
export async function POST(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const { handle } = await params;
  try {
    remoteManager().redraw(auth.principal, handle);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
