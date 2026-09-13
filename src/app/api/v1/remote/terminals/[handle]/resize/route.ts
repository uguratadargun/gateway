import { NextResponse } from "next/server";
import { z } from "zod";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ handle: string }> };

const resizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }).strict();

/** The size the cockpit's terminal was fitted to. The last cockpit to fit it wins. */
export async function POST(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const parsed = resizeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid size", issues: parsed.error.issues }, { status: 400 });
  const { handle } = await params;
  try {
    remoteManager().resize(auth.principal, handle, parsed.data.cols, parsed.data.rows);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
