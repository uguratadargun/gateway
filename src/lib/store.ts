import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeAccount } from "./claude/oauth";

/**
 * Encrypted on-disk credential store for a single Claude account. Tokens are
 * sealed with AES-256-GCM under a key derived from GATE_SECRET so the file at
 * rest never contains plaintext refresh tokens.
 */

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  /** Absolute epoch-ms expiry, derived from expires_in at write time. */
  expiresAt: number;
  scope?: string;
  account?: ClaudeAccount | null;
  /** Persisted once at first login; the Claude Code device_id (64 hex). */
  cliUserID: string;
  connectedAt: number;
  updatedAt: number;
}

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");
const CRED_FILE = join(GATE_DIR, "credentials.json");

function key(): Buffer {
  const secret = process.env.GATE_SECRET;
  if (!secret) {
    throw new Error(
      "GATE_SECRET is not set. Set a long random string in .env to encrypt stored credentials.",
    );
  }
  return createHash("sha256").update(secret).digest();
}

function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

function open(sealed: string): string {
  const [ivB64, tagB64, encB64] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function newCliUserID(): string {
  return randomBytes(32).toString("hex");
}

export function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CRED_FILE)) return null;
  try {
    return JSON.parse(open(readFileSync(CRED_FILE, "utf8"))) as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CRED_FILE, seal(JSON.stringify(creds)), { mode: 0o600 });
}

export function clearCredentials(): void {
  if (existsSync(CRED_FILE)) writeFileSync(CRED_FILE, "");
}
