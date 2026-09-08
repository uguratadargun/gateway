import { NextResponse } from "next/server";

import { countAccounts, deleteAccount, getAccount, updateAccount } from "@/lib/accounts";
import { resetRateLimit } from "@/lib/ratelimit";
import { updateAccountSchema } from "@/lib/schemas";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Rename an account, park it, or move it in the pool order. */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = updateAccountSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch", issues: parsed.error.issues }, { status: 400 });
  }
  const account = updateAccount(id, parsed.data);
  if (!account) return NextResponse.json({ error: "No such account" }, { status: 404 });
  return NextResponse.json(account);
}

/** Disconnect one account. */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!getAccount(id)) return NextResponse.json({ error: "No such account" }, { status: 404 });
  deleteAccount(id);
  // The global rate-limit snapshot describes whoever answered last. With the
  // pool empty it describes an account gate no longer has, and the throttle
  // would refuse the next connection's traffic on the strength of it.
  if (countAccounts() === 0) resetRateLimit();
  return NextResponse.json({ ok: true });
}
