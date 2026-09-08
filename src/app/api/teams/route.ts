import { NextResponse } from "next/server";

import { createTeamSchema } from "@/lib/schemas";
import { createTeam, listTeams, listUsers } from "@/lib/teams";

export const runtime = "nodejs";

/** Teams, with how many people are in each — the whole of the /team page's list. */
export async function GET() {
  const users = listUsers();
  return NextResponse.json({
    teams: listTeams().map((t) => ({ ...t, userCount: users.filter((u) => u.teamId === t.id).length })),
  });
}

export async function POST(req: Request) {
  const parsed = createTeamSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid team", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(createTeam(parsed.data.name, parsed.data.id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
