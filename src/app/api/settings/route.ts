import { NextResponse } from "next/server";

import { settingsPatchSchema } from "@/lib/schemas";
import { loadSettings, saveSettings } from "@/lib/settings";
import { pruneTraffic } from "@/lib/traffic";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(loadSettings());
}

export async function PUT(req: Request) {
  const parsed = settingsPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const saved = saveSettings(parsed.data);
  // Pruning lives here, not on the read path (decision 0017's own rationale:
  // "a read path that triggers a write path on a timer is a bad trade", and
  // /traffic polls every six seconds) and not on every write either — only
  // when the patch touched the traffic section, so lowering the window from
  // the settings panel takes effect the moment the person presses Save.
  if (parsed.data.traffic) pruneTraffic();
  return NextResponse.json(saved);
}
