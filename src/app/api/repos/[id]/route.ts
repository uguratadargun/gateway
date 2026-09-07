import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteRepo, getRepo, updateRepo } from "@/repos/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const argv = z.array(z.array(z.string().min(1)).min(1)).max(20);
const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    baseRef: z.string().max(200).nullable().optional(),
    setup: argv.optional(),
    prepare: argv.optional(),
  })
  .strict();

export async function GET(_req: Request, { params }: Params) {
  const repo = getRepo((await params).id);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid patch", issues: parsed.error.issues }, { status: 400 });
  const repo = updateRepo((await params).id, parsed.data);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

/**
 * Forget a repository. The checkout is left on disk even when gate cloned it:
 * a run's worktree may still be branched from it, and deleting a working tree
 * from under one is not something a "remove from the list" button should do.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });
  deleteRepo(id);
  return NextResponse.json({ deleted: true, checkoutLeftAt: repo.root });
}
