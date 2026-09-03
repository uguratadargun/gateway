import { NextResponse } from "next/server";

import { getSession } from "@/lib/usage";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json(getSession(id));
}
