import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Transient store for the in-flight PKCE verifier/state between the login
 * "start" and "callback" steps. Single pending login at a time (personal app).
 */

const GATE_DIR = process.env.GATE_HOME || join(homedir(), ".gate");
const PENDING_FILE = join(GATE_DIR, "pending-login.json");

export interface PendingLogin {
  verifier: string;
  state: string;
  createdAt: number;
}

export function savePending(p: PendingLogin): void {
  if (!existsSync(GATE_DIR)) mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PENDING_FILE, JSON.stringify(p), { mode: 0o600 });
}

export function loadPending(): PendingLogin | null {
  if (!existsSync(PENDING_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf8")) as PendingLogin;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  if (existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
}
