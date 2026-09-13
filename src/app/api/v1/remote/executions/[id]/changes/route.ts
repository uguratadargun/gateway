import { NextResponse } from "next/server";

import { getExecution } from "@/executions/store";
import { ownsExecution } from "@/lib/tenancy";
import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** What a remote run has changed so far, read live from its worktree on this server. */
export async function GET(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (!ownsExecution(execution, auth.principal)) return NextResponse.json({ error: "not your run" }, { status: 403 });
  try {
    return NextResponse.json({ files: await remoteManager().changes(auth.principal, id) });
  } catch (e) {
    if (e instanceof Error && !(e.name === "RemoteError")) return NextResponse.json({ error: e.message }, { status: 409 });
    return remoteErrorResponse(e);
  }
}
