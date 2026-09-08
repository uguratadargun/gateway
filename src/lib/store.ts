import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeAccount } from "./claude/oauth";
import { tryOpen } from "./seal";

/**
 * The credential shape one connected Claude login carries. Several of these
 * live in the accounts pool (see accounts.ts); this module keeps the type, the
 * device-id generator, and the reader for the pre-pool single-account file.
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

export function newCliUserID(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Read the single-account credentials.json written before the pool existed.
 * Returns null once it has been imported and retired.
 */
export function readLegacyCredentials(): StoredCredentials | null {
  if (!existsSync(CRED_FILE)) return null;
  const plain = tryOpen(readFileSync(CRED_FILE, "utf8"));
  if (!plain) return null;
  try {
    const creds = JSON.parse(plain) as StoredCredentials;
    return creds.refreshToken ? creds : null;
  } catch {
    return null;
  }
}

/** Rename the legacy file so the import runs exactly once. */
export function retireLegacyCredentials(): void {
  if (!existsSync(CRED_FILE)) return;
  try {
    renameSync(CRED_FILE, CRED_FILE + ".migrated");
  } catch {
    // best-effort: a second import is idempotent on account_uuid anyway
  }
}
