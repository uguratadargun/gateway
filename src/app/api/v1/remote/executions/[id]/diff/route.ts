import { NextResponse } from "next/server";
import { z } from "zod";

import { getExecution } from "@/executions/store";
import { ownsExecution } from "@/lib/tenancy";
import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const fileSchema = z.object({
  file: z.object({
    path: z.string().min(1).max(4096),
    oldPath: z.string().max(4096).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
    untracked: z.boolean(),
  }),
});

/** One changed file's diff in a remote run's worktree. */
export async function POST(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const parsed = fileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid file", issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  const execution = getExecution(id);
  if (!execution) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (!ownsExecution(execution, auth.principal)) return NextResponse.json({ error: "not your run" }, { status: 403 });
  try {
    return NextResponse.json({ diff: await remoteManager().fileDiff(auth.principal, id, parsed.data.file) });
  } catch (e) {
    if (e instanceof Error && e.name !== "RemoteError") return NextResponse.json({ error: e.message }, { status: 409 });
    return remoteErrorResponse(e);
  }
}
