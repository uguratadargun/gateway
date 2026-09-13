import { NextResponse } from "next/server";
import { z } from "zod";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const settleSchema = z.union([
  z
    .object({
      answer: z.object({
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
        response: z.string().max(20_000).optional(),
      }),
    })
    .strict(),
  z
    .object({
      decision: z.union([
        z.object({ behavior: z.literal("allow"), always: z.boolean().optional() }),
        z.object({ behavior: z.literal("deny"), message: z.string().max(20_000) }),
      ]),
    })
    .strict(),
]);

/** Answers a held question, or settles a held permission prompt; the session goes on at once. */
export async function POST(req: Request, { params }: Params) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const parsed = settleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid answer", issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  try {
    if ("answer" in parsed.data) remoteManager().answer(auth.principal, id, parsed.data.answer);
    else remoteManager().decide(auth.principal, id, parsed.data.decision);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
