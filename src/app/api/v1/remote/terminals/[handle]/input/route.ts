import { NextResponse } from "next/server";
import { z } from "zod";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ handle: string }> };

const inputSchema = z.object({ data: z.string().max(1_000_000) }).strict();

/** Keystrokes and pastes, as the terminal emulator produced them. */
export async function POST(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  const { handle } = await params;
  try {
    remoteManager().write(auth.principal, handle, parsed.data.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
