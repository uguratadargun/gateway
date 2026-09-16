import { NextResponse } from "next/server";
import { z } from "zod";

import { getTeam } from "@/lib/teams";
import { removeRepoCheckout } from "@/repos/setup";
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
    teamId: z.string().min(1).max(64).nullable().optional(),
    /** Null turns publishing off for this repository. */
    publicationRemote: z.string().max(500).nullable().optional(),
    /** Null resets to the default (`gate/*`). */
    branchPolicy: z.string().max(200).nullable().optional(),
  })
  .strict();

export async function GET(_req: Request, { params }: Params) {
  const repo = getRepo((await params).id);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid patch", issues: parsed.error.issues }, { status: 400 });
  // Null hands the repository back to nobody, which is a value. A team id that
  // names no team is not: it would put the repository outside every asker's
  // family, and read on the page as though it had an owner.
  if (parsed.data.teamId && !getTeam(parsed.data.teamId)) {
    return NextResponse.json({ error: `no team "${parsed.data.teamId}"` }, { status: 400 });
  }
  const repo = updateRepo((await params).id, parsed.data);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

/**
 * Forget a repository, and remove the checkout if it was gate's to remove.
 *
 * A checkout gate cloned goes with the record: leaving it behind made the id
 * unusable, since reconnecting the same repository landed on a directory
 * nothing claimed any more. A checkout somebody else's path pointed at is
 * never touched, and neither is one a run's worktree still branches from —
 * both cases say so rather than deleting quietly or failing.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });
  const checkout = removeRepoCheckout(repo);
  deleteRepo(id);
  return NextResponse.json({
    deleted: true,
    checkoutRemoved: checkout.removed,
    ...(checkout.removed ? {} : { checkoutLeftAt: checkout.root, keptBecause: checkout.kept }),
  });
}
