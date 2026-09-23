import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { repoRecordFor } from "@/memory/record-index";
import { memoryScopeFor } from "@/memory/store";
import { canonicalRepoId } from "@/repos/identity";

export const runtime = "nodejs";

/**
 * Whether the checkout asking is a repository the gate reads — connected,
 * whose team, where its last read stands. Named from the raw remote the
 * client sends, like every other read.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const remote = new URL(req.url).searchParams.get("remote");
  const repoId = remote ? canonicalRepoId(remote) : null;
  return NextResponse.json(repoRecordFor(memoryScopeFor(auth.teamId), repoId));
}
