import { NextResponse } from "next/server";

import { applyClaudeCode, detectClients, revertClaudeCode } from "@/lib/clients";
import { clientApplySchema } from "@/lib/schemas";

export const runtime = "nodejs";

/** Base URL clients should use. `localhost` may resolve to ::1 while we bind 127.0.0.1. */
function baseUrlFor(req: Request): string {
  const u = new URL(req.url);
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  return u.origin;
}

export async function GET(req: Request) {
  return NextResponse.json({ baseUrl: baseUrlFor(req), clients: detectClients(baseUrlFor(req)) });
}

export async function POST(req: Request) {
  const parsed = clientApplySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  const { action, apiKey } = parsed.data;
  try {
    const result = action === "apply" ? applyClaudeCode(baseUrlFor(req), apiKey) : revertClaudeCode();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update client config" }, { status: 500 });
  }
}
