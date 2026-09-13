/**
 * The few Bot API calls the gate bot makes, over plain fetch.
 *
 * Long polling rather than a webhook: a gate is usually on a machine nothing
 * on the internet can reach, and `getUpdates` needs nothing from the network
 * but a way out. Everything the bot sends is HTML-formatted, so text that came
 * from a session is escaped before it gets here (see render.ts).
 */

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Keyboard = InlineButton[][];

export interface SendOptions {
  keyboard?: Keyboard;
  /** Opens the reply box on the person's side, so the next thing they type answers this. */
  forceReply?: boolean;
}

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<{ message_id: number }>;
  /** Replaces a message's text and keyboard; no keyboard removes the buttons. */
  editMessage(chatId: string, messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  setCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds Telegram asked us to wait before the next call, on a 429. */
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export function httpTelegramApi(token: string, base = process.env.GATE_TELEGRAM_API_URL || "https://api.telegram.org"): TelegramApi {
  const root = `${base.replace(/\/+$/, "")}/bot${token}`;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // The token is in the URL; a network error's message must not carry it anywhere.
      throw new TelegramError(`could not reach Telegram (${(e as Error).name})`, 0, null);
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!data?.ok) {
      throw new TelegramError(
        `Telegram ${method}: ${data?.description ?? `HTTP ${res.status}`}`,
        res.status,
        data?.parameters?.retry_after ?? null,
      );
    }
    return data.result as T;
  }

  const markup = (opts?: SendOptions) =>
    opts?.forceReply
      ? { reply_markup: { force_reply: true } }
      : opts?.keyboard
        ? { reply_markup: { inline_keyboard: opts.keyboard } }
        : {};

  return {
    getMe: () => call<TgUser>("getMe", {}),
    getUpdates: (offset, timeoutSec, signal) =>
      call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal),
    sendMessage: (chatId, text, opts) =>
      call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...markup(opts),
      }),
    editMessage: async (chatId, messageId, text, keyboard) => {
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: keyboard ?? [] },
        });
      } catch (e) {
        // Pressing a button that changes nothing is not an error worth a log line.
        if (e instanceof TelegramError && /message is not modified/i.test(e.message)) return;
        throw e;
      }
    },
    answerCallback: async (callbackId, text) => {
      await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    },
    setCommands: async (commands) => {
      await call("setMyCommands", { commands });
    },
  };
}
