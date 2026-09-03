import { NextResponse } from "next/server";

import { createKey, listKeys } from "@/lib/apikeys";
import { createKeySchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ keys: listKeys() });
}

export async function POST(req: Request) {
  const parsed = createKeySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid key name", issues: parsed.error.issues }, { status: 400 });
  }
  const { key, plaintext } = createKey(parsed.data.name);
  // plaintext returned ONCE — never stored or shown again.
  return NextResponse.json({ id: key.id, name: key.name, plaintext });
}
