import { NextResponse } from "next/server";

import { updateUserSchema } from "@/lib/schemas";
import { deleteUser, updateUser } from "@/lib/teams";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = updateUserSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const user = updateUser(id, parsed.data);
    if (!user) return NextResponse.json({ error: "no such user" }, { status: 404 });
    return NextResponse.json(user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Deleting a person revokes every key they held, in the same step. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteUser(id) });
}
