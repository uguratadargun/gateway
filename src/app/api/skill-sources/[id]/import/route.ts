import { NextResponse } from "next/server";
import { z } from "zod";

import { scopeFromRequest } from "@/lib/def-root";
import { getTeam } from "@/lib/teams";
import { WorkflowError } from "@/runtime/errors";
import { importSkills } from "@/skills/sources";

export const runtime = "nodejs";

const importSchema = z
  .object({
    /** Directory names as they are upstream, which is what the list offers. */
    skills: z.array(z.string().min(1).max(200)).min(1).max(100),
    /** Overwriting a skill somebody may have edited here is said out loud. */
    replace: z.boolean().default(false),
  })
  .strict();

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = importSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid import", issues: parsed.error.issues }, { status: 400 });
  const scope = scopeFromRequest(req, (t) => !!getTeam(t));
  try {
    return NextResponse.json(importSkills(id, parsed.data.skills, scope, parsed.data.replace));
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
