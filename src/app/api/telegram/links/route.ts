import { NextResponse } from "next/server";
import { z } from "zod";

import { startTelegram } from "@/telegram/runtime";
import { createLinkCode } from "@/telegram/store";

export const runtime = "nodejs";

const schema = z.object({ userId: z.string().min(1).nullable().optional() }).strict();

/**
 * A one-time link for a person's Telegram chat. Opening it (or sending the
 * `/start` line to the bot) links the chat and gives it a key that may run
 * sessions on this server, so it is made for a named person, on purpose.
 */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid link request", issues: parsed.error.issues }, { status: 400 });
  const status = startTelegram();
  if (!status.configured) return NextResponse.json({ error: "set up the Telegram bot first" }, { status: 409 });
  try {
    const { code, expiresAt } = createLinkCode(parsed.data.userId ?? null);
    return NextResponse.json({
      code,
      expiresAt,
      command: `/start ${code}`,
      url: status.username ? `https://t.me/${status.username}?start=${code}` : null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
