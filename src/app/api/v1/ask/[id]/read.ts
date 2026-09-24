import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { AskReadError, openAsk, type AskRecord } from "@/orchestration/ask-source";
import type { RepoRecord } from "@/repos/store";

/**
 * One read-only question about an ask's commit, answered as `{ text }`.
 * Shared by the tree, grep and file routes, which differ only in the git
 * command behind them.
 */
export async function answerAskRead(
  req: Request,
  params: Promise<{ id: string }>,
  read: (ask: AskRecord, repo: RepoRecord, query: URLSearchParams) => string,
): Promise<Response> {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const { ask, repo } = openAsk(id, auth.teamId);
    return NextResponse.json({ text: read(ask, repo, new URL(req.url).searchParams) });
  } catch (e) {
    if (e instanceof AskReadError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
