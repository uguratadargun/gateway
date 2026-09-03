import { NextResponse } from "next/server";

import { buildAuthUrl } from "@/lib/claude/oauth";
import { createPkce } from "@/lib/claude/pkce";
import { savePending } from "@/lib/pkce-session";

export const runtime = "nodejs";

/** Begin the Claude Code OAuth login: returns the authorize URL to open. */
export async function POST() {
  const { verifier, challenge, state } = createPkce();
  savePending({ verifier, state, createdAt: Date.now() });
  return NextResponse.json({ authUrl: buildAuthUrl(state, challenge) });
}
