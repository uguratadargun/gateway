import { NextResponse } from "next/server";

import { telegramBot } from "@/telegram/runtime";
import { unlink } from "@/telegram/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ chatId: string }> };

/** Unlinks a chat: its key is revoked and the bot stops sending to it. */
export async function DELETE(_req: Request, { params }: Params) {
  const { chatId } = await params;
  if (!unlink(chatId)) return NextResponse.json({ error: `no linked chat ${chatId}` }, { status: 404 });
  telegramBot()?.detach(chatId);
  return NextResponse.json({ ok: true });
}
