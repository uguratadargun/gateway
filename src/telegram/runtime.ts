import { remoteManager } from "@/remote/manager";

import { httpTelegramApi } from "./api";
import { TelegramBot } from "./bot";
import { botToken } from "./store";

/**
 * The one bot this process runs. Route handlers and the startup hook are
 * separate module graphs in Next, so it hangs off globalThis like the remote
 * manager does; two pollers on one token would take each other's updates.
 */

const g = globalThis as unknown as { __gateTelegram?: { bot: TelegramBot | null; token: string | null } };

export interface TelegramStatus {
  configured: boolean;
  source: "env" | "dashboard" | null;
  running: boolean;
  username: string | null;
  error: string | null;
}

export function telegramBot(): TelegramBot | null {
  return g.__gateTelegram?.bot ?? null;
}

/** Starts the bot for the configured token, restarting it when the token changed; stops it when there is none. */
export function startTelegram(): TelegramStatus {
  const { token } = botToken();
  const current = g.__gateTelegram;
  if (current && current.token === token) return telegramStatus();
  current?.bot?.stop();
  const bot = token ? new TelegramBot({ api: httpTelegramApi(token), remote: remoteManager }) : null;
  g.__gateTelegram = { bot, token };
  bot?.start();
  return telegramStatus();
}

export function telegramStatus(): TelegramStatus {
  const { token, source } = botToken();
  const bot = g.__gateTelegram?.token === token ? (g.__gateTelegram?.bot ?? null) : null;
  return {
    configured: !!token,
    source,
    running: !!bot?.running,
    username: bot?.username ?? null,
    error: bot?.lastError ?? null,
  };
}
