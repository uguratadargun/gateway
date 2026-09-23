import { NextResponse } from "next/server";

import { requireClient } from "@/lib/tenancy";
import { toFeatureCard } from "@/memory/cards";
import { listFeatures, memoryScopeFor } from "@/memory/store";

export const runtime = "nodejs";

/**
 * The tree's feature catalogue, for `gate memory features`: every id a design
 * doc could be named, and which teams have built each. `/gate:init` reads it
 * before naming a design doc, because the file name is the feature's id across
 * the tree and a second name for the same feature is two features.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ features: listFeatures(memoryScopeFor(auth.teamId)).map((f) => toFeatureCard(f)) });
}
