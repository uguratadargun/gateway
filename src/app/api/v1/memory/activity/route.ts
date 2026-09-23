import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { LocalMemoryAccess } from "@/memory/access";

export const runtime = "nodejs";

/**
 * Every run of the caller's tree going right now — who, on what, where —
 * except the caller's own. For `gate memory activity`: the answer to "is
 * anybody else already on this" before there is a run to ask it.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const activity = await new LocalMemoryAccess(auth.teamId, null, { userId: auth.userId }).activity();
  return NextResponse.json({ activity });
}
