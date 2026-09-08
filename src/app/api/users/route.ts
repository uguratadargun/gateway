import { NextResponse } from "next/server";

import { createUserSchema } from "@/lib/schemas";
import { createUser, listUsers } from "@/lib/teams";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const teamId = new URL(req.url).searchParams.get("team") ?? undefined;
  return NextResponse.json({ users: listUsers(teamId) });
}

export async function POST(req: Request) {
  const parsed = createUserSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid user", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(createUser(parsed.data));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
