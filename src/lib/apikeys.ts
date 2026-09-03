import { createHash, randomBytes } from "node:crypto";

import { getDb } from "./db";

/**
 * Gateway API keys. Multiple keys can be issued (one per tool/app) so usage can
 * be attributed and keys revoked individually. Only the SHA-256 hash is stored;
 * the plaintext key is shown once at creation.
 */

export interface ApiKey {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
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
  };
}

export function listKeys(): Omit<ApiKey, "hash">[] {
  return (getDb().prepare("SELECT * FROM apikeys ORDER BY created_at ASC").all() as any[]).map((r) => {
    const { hash: _hash, ...rest } = rowToKey(r);
    return rest;
  });
}

/** Create a key; returns the plaintext ONCE (never recoverable afterward). */
export function createKey(name: string): { key: ApiKey; plaintext: string } {
  const plaintext = `gate_${randomBytes(24).toString("hex")}`;
  const key: ApiKey = {
    id: randomBytes(8).toString("hex"),
    name: name.trim() || "unnamed",
    hash: hashKey(plaintext),
    prefix: plaintext.slice(0, 12),
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
  };
  getDb()
    .prepare("INSERT INTO apikeys (id,name,hash,prefix,created_at,last_used_at,revoked) VALUES (?,?,?,?,?,?,0)")
    .run(key.id, key.name, key.hash, key.prefix, key.createdAt, null);
  return { key, plaintext };
}

export function revokeKey(id: string): boolean {
  return Number(getDb().prepare("UPDATE apikeys SET revoked = 1 WHERE id = ?").run(id).changes) > 0;
}

export function deleteKey(id: string): boolean {
  return Number(getDb().prepare("DELETE FROM apikeys WHERE id = ?").run(id).changes) > 0;
}

/** Returns true if an active key matches; touches lastUsedAt. */
export function verifyKey(raw: string): boolean {
  if (!raw) return false;
  const changes = getDb()
    .prepare("UPDATE apikeys SET last_used_at = ? WHERE hash = ? AND revoked = 0")
    .run(Date.now(), hashKey(raw)).changes;
  return Number(changes) > 0;
}

/** True when at least one non-revoked key exists (gateway then requires a key). */
export function hasActiveKeys(): boolean {
  return Number(getDb().prepare("SELECT COUNT(*) AS n FROM apikeys WHERE revoked = 0").get().n) > 0;
}
