import { NextResponse } from "next/server";

import { settingsPatchSchema } from "@/lib/schemas";
import { loadSettings, saveSettings } from "@/lib/settings";

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
  return NextResponse.json(saveSettings(parsed.data));
}
