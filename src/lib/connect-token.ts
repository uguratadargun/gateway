/**
 * One string that says both where a gate is and who is connecting to it.
 *
 * Onboarding used to be two facts a person had to carry from a web page into a
 * terminal — a URL and a key — as flags on a command they had to be told about
 * first. Every one of those is a place to mistype something and get an error
 * that does not say which half is wrong. A connection token carries both, so
 * the dashboard hands out one thing and `/gate:login <token>` is the whole of
 * what anyone types.
 *
 * It is not encryption and does not pretend to be: the key is in there in
 * plain sight, base64 away. It is a credential, handled like one — the point
 * of the encoding is that it travels as a single unbreakable unit, not that it
 * hides anything.
 *
 * Isomorphic on purpose: the dashboard builds one in the browser and the CLI
 * reads it in node, so this file may import nothing.
 */

export const CONNECT_TOKEN_PREFIX = "gatec_";

export interface Connection {
  url: string;
  key: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function encodeConnectionToken(connection: Connection): string {
  const json = JSON.stringify({ u: connection.url.replace(/\/+$/, ""), k: connection.key });
  return CONNECT_TOKEN_PREFIX + toBase64Url(new TextEncoder().encode(json));
}

export function looksLikeConnectionToken(value: string): boolean {
  return value.trim().startsWith(CONNECT_TOKEN_PREFIX);
}

/**
 * Reads a token, or says what is wrong with it.
 *
 * Throws rather than returning null: every caller is about to tell a person
 * why the thing they pasted did not work, and "invalid token" without the
 * reason sends them back to the dashboard to copy the same string again.
 */
export function decodeConnectionToken(value: string): Connection {
  const token = value.trim();
  if (!looksLikeConnectionToken(token)) {
    throw new Error(`that does not look like a gate token (they start with ${CONNECT_TOKEN_PREFIX})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(token.slice(CONNECT_TOKEN_PREFIX.length))));
  } catch {
    throw new Error("this token is damaged — copy it again from your gate dashboard, all of it");
  }
  const { u, k } = (parsed ?? {}) as { u?: unknown; k?: unknown };
  if (typeof u !== "string" || typeof k !== "string" || !u || !k) {
    throw new Error("this token is missing the gate address or the key");
  }
  if (!/^https?:\/\//.test(u)) {
    throw new Error(`this token points at "${u}", which is not an http(s) address`);
  }
  return { url: u.replace(/\/+$/, ""), key: k };
}
