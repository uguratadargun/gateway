import { NextResponse } from "next/server";

import { memorySearchSchema } from "@/lib/client-api-schemas";
import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { LocalMemoryAccess } from "@/memory/access";

export const runtime = "nodejs";

/**
 * The dashboard's window on memory. `?team=` picks whose tree is read, the
 * way the agent and workflow pages pick a team; the rest is the client API's.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = scopeFromRequest(req, (id) => !!getTeam(id));
  const parsed = memorySearchSchema.safeParse({
    query: url.searchParams.get("q") ?? undefined,
    paths: url.searchParams.getAll("path"),
    featureId: url.searchParams.get("feature") ?? undefined,
    asOf: url.searchParams.get("asOf") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid memory search", issues: parsed.error.issues }, { status: 400 });
  }
  const { query, paths, featureId, asOf, since, limit } = parsed.data;
  const result = await new LocalMemoryAccess(scope.teamId!).search({ query, paths: paths.length ? paths : undefined, featureId, asOf, since, limit });
  return NextResponse.json(result);
}
