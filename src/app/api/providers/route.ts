import { NextResponse } from "next/server";

import { createProvider, listProviders } from "@/lib/providers";
import { createProviderSchema } from "@/lib/schemas";

export const runtime = "nodejs";

/** Configured model endpoints: Ollama, vLLM, LM Studio, Z.AI, … */
export async function GET() {
  return NextResponse.json({ providers: listProviders() });
}

export async function POST(req: Request) {
  const parsed = createProviderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid provider", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    return NextResponse.json(createProvider(parsed.data), { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create provider";
    // A duplicate slug is the one failure a user can act on directly.
    const conflict = /UNIQUE constraint/i.test(message);
    return NextResponse.json(
      { error: conflict ? "A provider with that name already exists" : message },
      { status: conflict ? 409 : 400 },
    );
  }
}
