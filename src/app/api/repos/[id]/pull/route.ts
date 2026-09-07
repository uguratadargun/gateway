import { NextResponse } from "next/server";

import { pullRepo } from "@/repos/setup";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Bring a connected repository up to date with its remote.
 *
 * Runs branch from the checkout, so what the checkout knows is what every run
 * gets. Without this the only way to pick up a fix pushed from somewhere else
 * was to ssh in — and a pipeline whose test gate is failing on something
 * already fixed upstream is a pipeline that loops until its budget is gone.
 */
export async function POST(_req: Request, { params }: Params) {
  const repo = await pullRepo((await params).id);
  return repo ? NextResponse.json({ repo }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
