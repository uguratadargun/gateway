import { NextResponse } from "next/server";

import { createKey, listKeys } from "@/lib/apikeys";
import { createKeySchema } from "@/lib/schemas";
import { getUser, listUsers } from "@/lib/teams";

export const runtime = "nodejs";

/**
 * Keys, each with the person it was issued to. The owner is joined in here
 * rather than in SQL so a key whose user has since been deleted still lists —
 * it is revoked, not invisible.
 */
export async function GET(req: Request) {
  const teamId = new URL(req.url).searchParams.get("team") ?? undefined;
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const keys = listKeys(teamId).map((k) => ({
    ...k,
    owner: k.userId ? (users.get(k.userId) ?? null) : null,
  }));
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const parsed = createKeySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid key", issues: parsed.error.issues }, { status: 400 });
  }
  const { name, userId, teamId, scopes } = parsed.data;

  // A key issued to a person belongs to that person's team, whatever the caller
  // said: the two cannot disagree without one of them being wrong later.
  let team = teamId;
  if (userId) {
    const user = getUser(userId);
    if (!user) return NextResponse.json({ error: `no user "${userId}"` }, { status: 400 });
    team = user.teamId;
  }

  const { key, plaintext } = createKey({ name, userId: userId ?? null, teamId: team, scopes });
  // plaintext returned ONCE — never stored or shown again.
  return NextResponse.json({ id: key.id, name: key.name, teamId: key.teamId, scopes: key.scopes, plaintext });
}
