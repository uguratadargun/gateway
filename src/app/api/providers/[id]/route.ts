import { NextResponse } from "next/server";

import { deleteProvider, forgetProviderModels, getProvider, updateProvider } from "@/lib/local-providers";
import { updateProviderSchema } from "@/lib/schemas";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = updateProviderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const provider = updateProvider(id, parsed.data);
    if (!provider) return NextResponse.json({ error: "No such provider" }, { status: 404 });
    // The catalogue belongs to the old address / old key.
    forgetProviderModels(id);
    return NextResponse.json(provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update provider";
    const conflict = /UNIQUE constraint/i.test(message);
    return NextResponse.json(
      { error: conflict ? "A provider with that name already exists" : message },
      { status: conflict ? 409 : 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!getProvider(id)) return NextResponse.json({ error: "No such provider" }, { status: 404 });
  deleteProvider(id);
  forgetProviderModels(id);
  return NextResponse.json({ ok: true });
}
