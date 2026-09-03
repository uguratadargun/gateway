/**
 * Admin session auth for the dashboard and management API. Uses only Web
 * Crypto so it runs in both the Node route handlers and the edge middleware.
 *
 * Session token = `<expiresAtMs>.<hmac-sha256(secret, expiresAtMs)>`, stored in
 * an HttpOnly cookie. The secret comes from GATE_ADMIN_SECRET.
 */

export const ADMIN_COOKIE = "gate_admin";
export const ADMIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  return process.env.GATE_ADMIN_SECRET || "";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function adminConfigured(): boolean {
  return secret().length > 0;
}

/** Constant-time check of a submitted admin secret. */
export function verifyAdminSecret(input: string): boolean {
  const s = secret();
  return s.length > 0 && timingSafeEqual(input, s);
}

export async function createSessionToken(): Promise<string> {
  const exp = String(Date.now() + ADMIN_TTL_MS);
  return `${exp}.${await hmacHex(exp)}`;
}

export async function verifySessionToken(token: string | null | undefined): Promise<boolean> {
  if (!token || !adminConfigured()) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  return timingSafeEqual(sig, await hmacHex(expStr));
}
