import { NextResponse } from "next/server";

import { memorySearchSchema } from "@/lib/client-api-schemas";
import { requireClient } from "@/lib/tenancy";
import { LocalMemoryAccess } from "@/memory/access";
import { canonicalRepoId } from "@/repos/identity";

export const runtime = "nodejs";

/**
 * The team's memory, for a run on someone's machine and for `gate memory`.
 *
 * The scope is the key's team — its own tree — and nothing in the request
 * can widen it. The parameters are the same the memory_search tool takes.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const parsed = memorySearchSchema.safeParse({
    query: url.searchParams.get("q") ?? undefined,
    paths: url.searchParams.getAll("path"),
    remoteUrl: url.searchParams.get("remote") ?? undefined,
    featureId: url.searchParams.get("feature") ?? undefined,
    asOf: url.searchParams.get("asOf") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid memory search", issues: parsed.error.issues }, { status: 400 });
  }
  const { query, paths, remoteUrl, featureId, asOf, since, limit } = parsed.data;
  const result = await new LocalMemoryAccess(auth.teamId).search({
    query,
    paths: paths.length ? paths : undefined,
    // Named here rather than taken from the client, so a repository has one
    // name however old the asker is. Unreadable remote, no filter.
    repoId: remoteUrl ? canonicalRepoId(remoteUrl) : null,
    featureId,
    asOf,
    since,
    limit,
  });
  return NextResponse.json(result);
}
