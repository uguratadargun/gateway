import { NextResponse } from "next/server";

import { ADMIN_COOKIE, ADMIN_TTL_MS, createSessionToken, verifyAdminSecret } from "@/lib/admin-auth";
import { adminLoginSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const parsed = adminLoginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (!verifyAdminSecret(parsed.data.secret)) {
    return NextResponse.json({ error: "Wrong admin secret" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ADMIN_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production" && process.env.GATE_INSECURE_COOKIE !== "1",
  });
  return res;
}
