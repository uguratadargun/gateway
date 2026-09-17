import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { loadRoutingConfig, resetRoutingCache } from "@/lib/router";
import { routingPatchSchema } from "@/lib/schemas";

export const runtime = "nodejs";

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");
const ROUTING_FILE = process.env.GATE_ROUTING_FILE || join(GATE_DIR, "routing.json");

/** Read the effective routing config. */
export async function GET() {
  return NextResponse.json(loadRoutingConfig());
}

/** Persist a new routing config (partial merge handled on next load). */
export async function PUT(req: Request) {
  const parsed = routingPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid config", issues: parsed.error.issues }, { status: 400 });
  }
  const current = loadRoutingConfig();
  const patch = parsed.data;
  const merged = {
    ...current,
    ...patch,
    tiers: { ...current.tiers, ...patch.tiers },
    aliases: { ...current.aliases, ...patch.aliases },
  };
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(ROUTING_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  resetRoutingCache();
  return NextResponse.json(loadRoutingConfig());
}
