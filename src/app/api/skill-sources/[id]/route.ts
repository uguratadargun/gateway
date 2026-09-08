import { NextResponse } from "next/server";

import { deleteSource } from "@/skills/sources";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Forgets a library and removes gate's clone of it. Skills already imported
 * stay: they are the team's copies, and the point of importing rather than
 * reading through was that they do not move when the source does.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ deleted: deleteSource(id) });
}
