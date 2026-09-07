import { NextResponse } from "next/server";

import { runRepoSetup } from "@/repos/setup";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Re-run a repository's setup commands — after editing them, or after a failure. */
export async function POST(_req: Request, { params }: Params) {
  const repo = await runRepoSetup((await params).id);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
