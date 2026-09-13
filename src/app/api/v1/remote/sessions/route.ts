import { NextResponse } from "next/server";
import { z } from "zod";

import { remoteErrorResponse, requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";

export const runtime = "nodejs";

/** The caller's sessions on this server: the live terminals, then the ones asleep on disk. */
export async function GET(req: Request) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ sessions: remoteManager().sessions(auth.principal) });
}

const size = { cols: z.number().int().min(20).max(500).optional(), rows: z.number().int().min(5).max(200).optional() };
const startSchema = z.union([
  z.object({ repo: z.string().min(1).max(64), prompt: z.string().max(8_000).optional(), ...size }).strict(),
  z.object({ resume: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), ...size }).strict(),
]);

/** Starts a session in a connected repository, with an optional first prompt, or wakes one that is asleep. */
export async function POST(req: Request) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;
  const parsed = startSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid session request", issues: parsed.error.issues }, { status: 400 });
  try {
    const body = parsed.data;
    const session =
      "resume" in body
        ? await remoteManager().resume(auth.principal, auth.key, body.resume, body)
        : await remoteManager().start(auth.principal, auth.key, body);
    return NextResponse.json({ session }, { status: 201 });
  } catch (e) {
    return remoteErrorResponse(e);
  }
}
