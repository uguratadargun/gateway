import { askGrep } from "@/orchestration/ask-source";

import { answerAskRead } from "../read";

export const runtime = "nodejs";

/** The lines that match a pattern at the ask's commit. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return answerAskRead(req, params, (ask, repo, q) => askGrep(ask, repo, q.get("pattern"), q.get("path"), q.get("ext")));
}
