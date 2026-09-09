import { NextResponse } from "next/server";
import { z } from "zod";

import { WorkflowError } from "@/runtime/errors";
import { deleteSource, pinSource } from "@/skills/sources";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    /** A commit to hold the library at; null lets it follow the remote again. */
    pinnedSha: z.string().max(40).nullable(),
  })
  .strict();

/**
 * Pins a library to one commit, or unpins it. The clone does not move here:
 * the next Sync checks the pin out, the way it checks out anything else.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid pin", issues: parsed.error.issues }, { status: 400 });
  try {
    const source = pinSource(id, parsed.data.pinnedSha);
    if (!source) return NextResponse.json({ error: "no such skill source" }, { status: 404 });
    return NextResponse.json({ source });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/**
 * Forgets a library and removes gate's clone of it. Skills already imported
 * stay: they are the team's copies, and the point of importing rather than
 * reading through was that they do not move when the source does.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ deleted: deleteSource(id) });
}
