import { randomBytes } from "node:crypto";

import { createKey, resolveKey, revokeKey, type Principal } from "@/lib/apikeys";
import { getDb } from "@/lib/db";
import { seal, tryOpen } from "@/lib/seal";
import { DEFAULT_TEAM_ID, getUser } from "@/lib/teams";

/**
 * What the Telegram bot keeps: its token, the one-time codes that link a chat
 * to a person, and the links themselves.
 *
 * A chat is linked by a code the admin makes on the Team page for a person and
 * the person sends to the bot (`/start <code>`, which the t.me link does for
 * them). Redeeming it mints a key for that person with the `remote` scope —
 * the link is what lets a chat start sessions on this server, so it is issued
 * as deliberately as a remote key is — and keeps it sealed, because a remote
 * session runs on the plaintext. The key is resolved on every use, so revoking
 * it, disabling the person, or unlinking the chat stops the bot at once.
 */

const TOKEN_KV = "telegram.botToken";
const CODE_PREFIX = "telegram.link.";

/** How long a link code can be redeemed. */
export const LINK_CODE_MS = 15 * 60_000;

export const TELEGRAM_KEY_SCOPES = ["gateway", "workflows", "remote"] as const;

export interface TelegramLink {
  chatId: string;
  userId: string | null;
  teamId: string;
  keyId: string;
  username: string | null;
  linkedAt: number;
}

// -------------------------------------------------------------- token

/** The bot token, and where it came from: the environment wins over the dashboard. */
export function botToken(): { token: string | null; source: "env" | "dashboard" | null } {
  const env = process.env.GATE_TELEGRAM_BOT_TOKEN?.trim();
  if (env) return { token: env, source: "env" };
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(TOKEN_KV) as { value: string } | undefined;
  const token = tryOpen(row?.value);
  return token ? { token, source: "dashboard" } : { token: null, source: null };
}

export function saveBotToken(token: string | null): void {
  const db = getDb();
  if (!token?.trim()) {
    db.prepare("DELETE FROM kv WHERE key = ?").run(TOKEN_KV);
    return;
  }
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    TOKEN_KV,
    seal(token.trim()),
  );
}

// -------------------------------------------------------------- codes

interface CodeRecord {
  userId: string | null;
  teamId: string;
  expiresAt: number;
}

function sweepCodes(now: number): void {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE ?").all(`${CODE_PREFIX}%`) as Array<{ key: string; value: string }>;
  for (const r of rows) {
    let expiresAt = 0;
    try {
      expiresAt = (JSON.parse(r.value) as CodeRecord).expiresAt;
    } catch {
      // unreadable: gone with the expired ones
    }
    if (expiresAt <= now) db.prepare("DELETE FROM kv WHERE key = ?").run(r.key);
  }
}

/** A code that links the chat redeeming it to this person, or to the default team when nobody is named. */
export function createLinkCode(userId: string | null, now = Date.now()): { code: string; expiresAt: number } {
  let teamId = DEFAULT_TEAM_ID;
  if (userId) {
    const user = getUser(userId);
    if (!user) throw new Error(`no user "${userId}"`);
    if (user.disabled) throw new Error(`${user.email} is disabled`);
    teamId = user.teamId;
  }
  sweepCodes(now);
  // Telegram's start parameter takes [A-Za-z0-9_-], up to 64 characters.
  const code = randomBytes(18).toString("base64url");
  const record: CodeRecord = { userId, teamId, expiresAt: now + LINK_CODE_MS };
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(`${CODE_PREFIX}${code}`, JSON.stringify(record));
  return { code, expiresAt: record.expiresAt };
}

/**
 * Links the chat to the code's person, once: the code is gone whether or not it
 * still worked. A chat that was linked before is relinked, and its old key revoked.
 */
export function redeemLinkCode(code: string, chat: { chatId: string; username: string | null }, now = Date.now()): TelegramLink | null {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
  const db = getDb();
  const key = `${CODE_PREFIX}${code}`;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  let record: CodeRecord;
  try {
    record = JSON.parse(row.value) as CodeRecord;
  } catch {
    return null;
  }
  if (record.expiresAt <= now) return null;
  let teamId = record.teamId;
  if (record.userId) {
    const user = getUser(record.userId);
    if (!user || user.disabled) return null;
    teamId = user.teamId;
  }

  const previous = getLink(chat.chatId);
  if (previous) revokeKey(previous.keyId);

  const { key: minted, plaintext } = createKey({
    name: `telegram ${chat.username ? `@${chat.username}` : chat.chatId}`,
    userId: record.userId,
    teamId,
    scopes: [...TELEGRAM_KEY_SCOPES],
  });
  const link: TelegramLink = {
    chatId: chat.chatId,
    userId: record.userId,
    teamId,
    keyId: minted.id,
    username: chat.username,
    linkedAt: now,
  };
  db.prepare(
    `INSERT INTO telegram_links (chat_id, user_id, team_id, key_id, key_sealed, username, linked_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, team_id = excluded.team_id, key_id = excluded.key_id,
       key_sealed = excluded.key_sealed, username = excluded.username, linked_at = excluded.linked_at`,
  ).run(link.chatId, link.userId, link.teamId, link.keyId, seal(plaintext), link.username, link.linkedAt);
  return link;
}

// -------------------------------------------------------------- links

function rowToLink(r: any): TelegramLink {
  return {
    chatId: r.chat_id,
    userId: r.user_id ?? null,
    teamId: r.team_id,
    keyId: r.key_id,
    username: r.username ?? null,
    linkedAt: Number(r.linked_at),
  };
}

export function listLinks(): TelegramLink[] {
  return (getDb().prepare("SELECT * FROM telegram_links ORDER BY linked_at ASC").all() as any[]).map(rowToLink);
}

export function getLink(chatId: string): TelegramLink | null {
  const row = getDb().prepare("SELECT * FROM telegram_links WHERE chat_id = ?").get(chatId);
  return row ? rowToLink(row) : null;
}

/** Removes the link and revokes the key it held. */
export function unlink(chatId: string): boolean {
  const link = getLink(chatId);
  if (!link) return false;
  revokeKey(link.keyId);
  getDb().prepare("DELETE FROM telegram_links WHERE chat_id = ?").run(chatId);
  return true;
}

/** Who the chat acts as right now, or null when its key no longer works. */
export function credentialsFor(chatId: string): { link: TelegramLink; principal: Principal; key: string } | null {
  const row = getDb().prepare("SELECT * FROM telegram_links WHERE chat_id = ?").get(chatId) as any;
  if (!row) return null;
  const key = tryOpen(row.key_sealed);
  if (!key) return null;
  const principal = resolveKey(key, "telegram");
  if (!principal) return null;
  return { link: rowToLink(row), principal, key };
}
