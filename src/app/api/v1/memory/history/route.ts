import { NextResponse } from "next/server";

import { memoryHistorySchema } from "@/lib/client-api-schemas";
import { requireClient } from "@/lib/tenancy";
import { LocalMemoryAccess } from "@/memory/access";
import { canonicalRepoId } from "@/repos/identity";

export const runtime = "nodejs";

/**
 * What changed under some paths on a repository's base branch, each commit
 * with the record it names and the run it came from — for recall and blame
 * on someone's machine, and `gate memory history`. Read from the server's
 * checkout at the commit the record index last read; the family is the
 * boundary, as for every other read.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const parsed = memoryHistorySchema.safeParse({
    paths: url.searchParams.getAll("path"),
    remoteUrl: url.searchParams.get("remote") ?? undefined,
    repo: url.searchParams.get("repo") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid history request", issues: parsed.error.issues }, { status: 400 });
  }
  const { paths, remoteUrl, repo, since, limit } = parsed.data;
  const repoId = remoteUrl ? canonicalRepoId(remoteUrl) : (repo?.trim().toLowerCase() ?? null);
  const result = await new LocalMemoryAccess(auth.teamId).history({ repoId, paths, since, limit });
  return NextResponse.json(result);
}
