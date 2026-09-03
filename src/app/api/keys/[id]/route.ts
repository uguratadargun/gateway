import { NextResponse } from "next/server";

import { deleteKey, revokeKey } from "@/lib/apikeys";

export const runtime = "nodejs";

/** Revoke (keep the record) a key. */
export async function PATCH(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: revokeKey(id) });
}

/** Permanently delete a key. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteKey(id) });
}
