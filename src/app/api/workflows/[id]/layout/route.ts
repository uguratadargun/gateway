import { NextResponse } from "next/server";
import { z } from "zod";

import { getLayout, saveLayout } from "@/executions/store";

export const runtime = "nodejs";

/** Node positions live here, not in the workflow file: layout is not logic. */
const layoutSchema = z.record(z.string().min(1).max(64), z.object({ x: z.number(), y: z.number() }).strict());

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({ layout: getLayout(id) });
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = layoutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid layout", issues: parsed.error.issues }, { status: 400 });
  saveLayout(id, parsed.data);
  return NextResponse.json({ layout: parsed.data });
}
