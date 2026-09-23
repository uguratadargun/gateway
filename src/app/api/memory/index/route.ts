import { NextResponse } from "next/server";

import { indexAllRepos, recordIndexStatus } from "@/memory/record-index";

export const runtime = "nodejs";

/**
 * The record index, from the dashboard: where every connected repository's
 * read stands, and a read now. A read is code and git — a fetch per
 * repository, no model — so the button needs no confirmation.
 */
export async function GET() {
  return NextResponse.json({ repos: recordIndexStatus() });
}

export async function POST() {
  const outcomes = await indexAllRepos();
  // What was just read gets its vectors when there is a model to make them.
  await (await import("@/memory/hybrid")).embedMissing().catch(() => 0);
  return NextResponse.json({ outcomes, repos: recordIndexStatus() });
}
