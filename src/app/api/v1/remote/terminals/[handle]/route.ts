import { NextResponse } from "next/server";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ handle: string }> };

/** Ends a terminal. Its transcript stays: the session can be resumed later. */
export async function DELETE(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const { handle } = await params;
  try {
    remoteManager().close(auth.principal, handle);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
