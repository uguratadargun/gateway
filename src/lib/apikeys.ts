import { createHash, randomBytes } from "node:crypto";

import { DEFAULT_TEAM_ID } from "./teams";
import { getDb } from "./db";

/**
 * Gateway API keys. Multiple keys can be issued (one per tool/app) so usage can
 * be attributed and keys revoked individually. Only the SHA-256 hash is stored;
 * the plaintext key is shown once at creation.
 *
 * A key is also the identity the client CLI connects with: it names the person
 * it was issued to and the team whose agents and workflows they may pull, so
 * verifying a key answers "who is this" and not only "is this allowed".
 * Keys issued before there were users carry no owner and are read as the
 * default team's, which is what a single-person install has always been.
 */

/** What a key may reach. A key with neither scope is inert. */
export type KeyScope = "gateway" | "workflows";

export const ALL_SCOPES: KeyScope[] = ["gateway", "workflows"];

export interface ApiKey {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  userId: string | null;
  teamId: string;
  scopes: KeyScope[];
  /** Machine the key was last seen from, reported by the client CLI. */
  lastHost: string | null;
}

/** Who a verified key belongs to — the caller's identity for the rest of a request. */
export interface Principal {
  keyId: string;
  userId: string | null;
  teamId: string;
  scopes: KeyScope[];
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function parseScopes(raw: unknown): KeyScope[] {
  if (typeof raw !== "string") return [...ALL_SCOPES];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is KeyScope => (ALL_SCOPES as string[]).includes(s));
  return parts;
}

function rowToKey(r: any): ApiKey {
  return {
    id: r.id,
    name: r.name,
    hash: r.hash,
    prefix: r.prefix,
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    revoked: !!r.revoked,
    userId: r.user_id ?? null,
    teamId: r.team_id ?? DEFAULT_TEAM_ID,
    scopes: parseScopes(r.scopes),
    lastHost: r.last_host ?? null,
  };
}

export type PublicApiKey = Omit<ApiKey, "hash">;

export function listKeys(teamId?: string): PublicApiKey[] {
  const db = getDb();
  const rows = teamId
    ? db.prepare("SELECT * FROM apikeys WHERE team_id = ? ORDER BY created_at ASC").all(teamId)
    : db.prepare("SELECT * FROM apikeys ORDER BY created_at ASC").all();
  return (rows as any[]).map((r) => {
    const { hash: _hash, ...rest } = rowToKey(r);
    return rest;
  });
}

export function getKey(id: string): PublicApiKey | null {
  const row = getDb().prepare("SELECT * FROM apikeys WHERE id = ?").get(id);
  if (!row) return null;
  const { hash: _hash, ...rest } = rowToKey(row);
  return rest;
}

export interface CreateKeyInput {
  name: string;
  /** The person this key is for. Null keeps the pre-multi-user behaviour. */
  userId?: string | null;
  teamId?: string;
  scopes?: KeyScope[];
}

/** Create a key; returns the plaintext ONCE (never recoverable afterward). */
export function createKey(input: string | CreateKeyInput): { key: ApiKey; plaintext: string } {
  const opts: CreateKeyInput = typeof input === "string" ? { name: input } : input;
  const scopes = opts.scopes?.length ? opts.scopes : [...ALL_SCOPES];
  const plaintext = `gate_${randomBytes(24).toString("hex")}`;
  const key: ApiKey = {
    id: randomBytes(8).toString("hex"),
    name: opts.name.trim() || "unnamed",
    hash: hashKey(plaintext),
    prefix: plaintext.slice(0, 12),
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
    userId: opts.userId ?? null,
    teamId: opts.teamId ?? DEFAULT_TEAM_ID,
    scopes,
    lastHost: null,
  };
  getDb()
    .prepare(
      "INSERT INTO apikeys (id,name,hash,prefix,created_at,last_used_at,revoked,user_id,team_id,scopes) VALUES (?,?,?,?,?,?,0,?,?,?)",
    )
    .run(key.id, key.name, key.hash, key.prefix, key.createdAt, null, key.userId, key.teamId, scopes.join(","));
  return { key, plaintext };
}

export function revokeKey(id: string): boolean {
  return Number(getDb().prepare("UPDATE apikeys SET revoked = 1 WHERE id = ?").run(id).changes) > 0;
}

export function deleteKey(id: string): boolean {
  return Number(getDb().prepare("DELETE FROM apikeys WHERE id = ?").run(id).changes) > 0;
}

/**
 * Identifies the caller behind a key, or null when there is no live key for it.
 *
 * One statement does the lookup and the liveness check together — a revoked key
 * and an unknown one are the same answer — and touching `last_used_at` here is
 * what makes the dashboard's "last used" column true for every surface a key
 * can reach, not only the gateway.
 */
export function resolveKey(raw: string, host?: string | null): Principal | null {
  if (!raw) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM apikeys WHERE hash = ? AND revoked = 0").get(hashKey(raw));
  if (!row) return null;
  const key = rowToKey(row);
  // A disabled person's key stops working without anyone having to remember
  // which keys they held.
  if (key.userId) {
    const user = db.prepare("SELECT disabled FROM users WHERE id = ?").get(key.userId);
    if (user && user.disabled) return null;
  }
  db.prepare("UPDATE apikeys SET last_used_at = ?, last_host = COALESCE(?, last_host) WHERE id = ?").run(
    Date.now(),
    host ?? null,
    key.id,
  );
  return { keyId: key.id, userId: key.userId, teamId: key.teamId, scopes: key.scopes };
}

/** Returns true if an active key matches; touches lastUsedAt. */
export function verifyKey(raw: string): boolean {
  return resolveKey(raw) !== null;
}

/** True when at least one non-revoked key exists (gateway then requires a key). */
export function hasActiveKeys(): boolean {
  return Number(getDb().prepare("SELECT COUNT(*) AS n FROM apikeys WHERE revoked = 0").get().n) > 0;
}
