import { NextResponse } from "next/server";
import { z } from "zod";

import { listUsers } from "@/lib/teams";
import { httpTelegramApi, TelegramError } from "@/telegram/api";
import { startTelegram } from "@/telegram/runtime";
import { botToken, listLinks, saveBotToken } from "@/telegram/store";

export const runtime = "nodejs";

/** The bot's state and every linked chat, with the person each one acts as. */
function describe() {
  const status = startTelegram();
  const users = new Map(listUsers().map((u) => [u.id, u]));
  return {
    ...status,
    links: listLinks().map((l) => {
      const user = l.userId ? users.get(l.userId) : undefined;
      return {
        chatId: l.chatId,
        username: l.username,
        userId: l.userId,
        teamId: l.teamId,
        linkedAt: l.linkedAt,
        owner: user ? { email: user.email, name: user.name } : null,
      };
    }),
  };
}

export async function GET() {
  return NextResponse.json(describe());
}

const putSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^\d{3,}:[A-Za-z0-9_-]{20,}$/, "that does not look like a bot token from @BotFather")
      .nullable(),
  })
  .strict();

/** Sets the bot token (checked with Telegram first) or removes it, and restarts the bot. */
export async function PUT(req: Request) {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid token" }, { status: 400 });
  }
  if (botToken().source === "env") {
    return NextResponse.json({ error: "the bot token is set by GATE_TELEGRAM_BOT_TOKEN; change it there" }, { status: 409 });
  }
  if (parsed.data.token) {
    try {
      await httpTelegramApi(parsed.data.token).getMe();
    } catch (e) {
      const why = e instanceof TelegramError ? e.message : "could not reach Telegram";
      return NextResponse.json({ error: `Telegram did not accept this token (${why})` }, { status: 400 });
    }
  }
  saveBotToken(parsed.data.token);
  return NextResponse.json(describe());
}
