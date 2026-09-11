import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { LocalMemoryAccess } from "@/memory/access";

export const runtime = "nodejs";

/** One catalogue feature, with every team's implementation the caller may read. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const detail = await new LocalMemoryAccess(auth.teamId).feature(id);
  if (!detail) return NextResponse.json({ error: "no such feature in your team's catalogue" }, { status: 404 });
  return NextResponse.json(detail);
}
