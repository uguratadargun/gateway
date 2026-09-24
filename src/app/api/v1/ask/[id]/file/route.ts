import { askFile } from "@/orchestration/ask-source";

import { answerAskRead } from "../read";

export const runtime = "nodejs";

/** One file at the ask's commit, with line numbers. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return answerAskRead(req, params, (ask, repo, q) => askFile(ask, repo, q.get("path"), q.get("offset"), q.get("limit")));
}
