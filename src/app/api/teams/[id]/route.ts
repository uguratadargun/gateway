import { NextResponse } from "next/server";

import { updateTeamSchema } from "@/lib/schemas";
import { deleteTeam, setTeamParent } from "@/lib/teams";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Moves a team in the tree: under another team, or to the root with null. */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = updateTeamSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid team change", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(setTeamParent(id, parsed.data.parentId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json({ deleted: deleteTeam(id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
