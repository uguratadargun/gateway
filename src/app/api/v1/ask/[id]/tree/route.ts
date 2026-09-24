import { askTree } from "@/orchestration/ask-source";

import { answerAskRead } from "../read";

export const runtime = "nodejs";

/** The files under a directory at the ask's commit. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return answerAskRead(req, params, (ask, repo, q) => askTree(ask, repo, q.get("path"), q.get("depth")));
}
