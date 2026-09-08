import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing under a key derived from GATE_SECRET. Anything secret
 * that gate persists — Claude refresh tokens, provider API keys — goes through
 * here, so nothing at rest is plaintext.
 */

function key(): Buffer {
  const secret = process.env.GATE_SECRET;
  if (!secret) {
    throw new Error(
      "GATE_SECRET is not set. Set a long random string in .env to encrypt stored credentials.",
    );
  }
  return createHash("sha256").update(secret).digest();
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function open(sealed: string): string {
  const [ivB64, tagB64, encB64] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Decrypt without throwing — a blob sealed under a different GATE_SECRET is unreadable, not fatal. */
export function tryOpen(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    return open(sealed);
  } catch {
    return null;
  }
}
