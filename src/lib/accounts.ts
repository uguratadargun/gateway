import { randomUUID } from "node:crypto";

import { getDb } from "./db";
import { seal, tryOpen } from "./seal";
import { readLegacyCredentials, retireLegacyCredentials, type StoredCredentials } from "./store";

/**
 * The Claude account pool. Several logins live side by side; the router picks
 * one per request (see account-pool.ts) and the pool bookkeeping — priority,
 * last use, backoff level, cooldown, quota snapshot — lives on the row.
 *
 * Tokens never leave this module in plaintext: they are sealed under
 * GATE_SECRET in `accounts.sealed`, and the `Account` shape the dashboard and
 * the pool see deliberately carries none of them.
 */

export interface QuotaWindow {
  /** Percent USED (0..100). */
  utilization: number;
  /** ISO time when the window resets, when known. */
  resetsAt: string | null;
}

export interface AccountQuota {
  /** "five_hour" | "seven_day" | "seven_day_<model>" … */
  windows: Record<string, QuotaWindow>;
  plan?: string | null;
  source: "usage-endpoint" | "headers";
  /** Why the last poll failed, when it did. The windows shown stay the old ones. */
  error?: string | null;
}

export interface Account {
  id: string;
  label: string;
  accountUuid: string | null;
  email: string | null;
  organization: string | null;
  planTier: string | null;
  enabled: boolean;
  /** Lower = preferred. */
  priority: number;
  lastUsedAt: number | null;
  consecutiveUseCount: number;
  backoffLevel: number;
  cooldownUntil: number | null;
  lastError: string | null;
  quota: AccountQuota | null;
  quotaFetchedAt: number | null;
  connectedAt: number;
  updatedAt: number;
}

function mapAccount(row: Record<string, unknown>): Account {
  let quota: AccountQuota | null = null;
  if (row.quota_json) {
    try {
      quota = JSON.parse(String(row.quota_json)) as AccountQuota;
    } catch {
      quota = null;
    }
  }
  return {
    id: String(row.id),
    label: String(row.label),
    accountUuid: (row.account_uuid as string) ?? null,
    email: (row.email as string) ?? null,
    organization: (row.organization as string) ?? null,
    planTier: (row.plan_tier as string) ?? null,
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority ?? 100),
    lastUsedAt: (row.last_used_at as number) ?? null,
    consecutiveUseCount: Number(row.consecutive_use_count ?? 0),
    backoffLevel: Number(row.backoff_level ?? 0),
    cooldownUntil: (row.cooldown_until as number) ?? null,
    lastError: (row.last_error as string) ?? null,
    quota,
    quotaFetchedAt: (row.quota_fetched_at as number) ?? null,
    connectedAt: Number(row.connected_at),
    updatedAt: Number(row.updated_at),
  };
}

const ORDER = "ORDER BY priority ASC, connected_at ASC";

let legacyImported = false;

/**
 * Fold the pre-pool credentials.json into the table, once. Nothing else reads
 * that file any more, so a gate that upgrades keeps its connected account.
 */
function importLegacyAccount(): void {
  if (legacyImported) return;
  legacyImported = true;
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  if (Number(row.n) > 0) {
    retireLegacyCredentials();
    return;
  }
  const creds = readLegacyCredentials();
  if (!creds) return;
  addAccount(creds);
  retireLegacyCredentials();
}

export function listAccounts(): Account[] {
  importLegacyAccount();
  return (getDb().prepare(`SELECT * FROM accounts ${ORDER}`).all() as Array<Record<string, unknown>>).map(mapAccount);
}

export function getAccount(id: string): Account | null {
  const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapAccount(row) : null;
}

export function countAccounts(): number {
  importLegacyAccount();
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
}

function defaultLabel(creds: StoredCredentials): string {
  return (
    creds.account?.account_email ||
    creds.account?.organization_name ||
    `account ${new Date().toISOString().slice(0, 10)}`
  );
}

/**
 * Add a freshly authorized login, or re-authorize one already in the pool.
 * Anthropic identifies the login by account_uuid; a second login for the same
 * account refreshes its tokens rather than creating a duplicate row that would
 * share — and double-count — one quota.
 */
export function addAccount(creds: StoredCredentials, label?: string): Account {
  const uuid = creds.account?.account_uuid ?? null;
  const existing = uuid
    ? (getDb().prepare("SELECT * FROM accounts WHERE account_uuid = ?").get(uuid) as Record<string, unknown> | undefined)
    : undefined;
  const now = Date.now();

  if (existing) {
    const id = String(existing.id);
    getDb()
      .prepare(
        `UPDATE accounts
            SET sealed = ?, label = ?, email = ?, organization = ?, plan_tier = ?,
                enabled = 1, backoff_level = 0, cooldown_until = NULL, last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        seal(JSON.stringify(creds)),
        label ?? String(existing.label),
        creds.account?.account_email ?? null,
        creds.account?.organization_name ?? null,
        creds.account?.organization_rate_limit_tier ?? null,
        now,
        id,
      );
    return getAccount(id)!;
  }

  const id = randomUUID();
  // New logins land at the back of the pool; the dashboard reorders.
  const nextPriority = Number(
    (getDb().prepare("SELECT COALESCE(MAX(priority), 99) + 1 AS p FROM accounts").get() as { p: number }).p,
  );
  getDb()
    .prepare(
      `INSERT INTO accounts (id, label, sealed, account_uuid, email, organization, plan_tier,
                             enabled, priority, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      label ?? defaultLabel(creds),
      seal(JSON.stringify(creds)),
      uuid,
      creds.account?.account_email ?? null,
      creds.account?.organization_name ?? null,
      creds.account?.organization_rate_limit_tier ?? null,
      nextPriority,
      creds.connectedAt || now,
      now,
    );
  return getAccount(id)!;
}

export function updateAccount(
  id: string,
  patch: { label?: string; enabled?: boolean; priority?: number },
): Account | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    params.push(patch.label);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    params.push(patch.priority);
  }
  if (sets.length === 0) return getAccount(id);
  sets.push("updated_at = ?");
  params.push(Date.now(), id);
  getDb().prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getAccount(id);
}

export function deleteAccount(id: string): boolean {
  return Number(getDb().prepare("DELETE FROM accounts WHERE id = ?").run(id).changes) > 0;
}

// ── credentials ─────────────────────────────────────────────────────────────

export function loadAccountCredentials(id: string): StoredCredentials | null {
  const row = getDb().prepare("SELECT sealed FROM accounts WHERE id = ?").get(id) as { sealed: string } | undefined;
  const plain = tryOpen(row?.sealed);
  if (!plain) return null;
  try {
    return JSON.parse(plain) as StoredCredentials;
  } catch {
    return null;
  }
}

/** Persist rotated tokens for one account. Identity columns are left alone. */
export function saveAccountCredentials(id: string, creds: StoredCredentials): void {
  getDb()
    .prepare("UPDATE accounts SET sealed = ?, updated_at = ? WHERE id = ?")
    .run(seal(JSON.stringify(creds)), Date.now(), id);
}

// ── pool bookkeeping ────────────────────────────────────────────────────────

/** Sticky round-robin: who served last, and how many times in a row. */
export function touchAccountUse(id: string, consecutiveUseCount: number): void {
  getDb()
    .prepare("UPDATE accounts SET last_used_at = ?, consecutive_use_count = ? WHERE id = ?")
    .run(Date.now(), consecutiveUseCount, id);
}

export function setAccountCooldown(
  id: string,
  until: number,
  error: string | null,
  backoffLevel?: number,
): void {
  const sets = ["cooldown_until = ?", "last_error = ?", "updated_at = ?"];
  const params: unknown[] = [until, error, Date.now()];
  if (backoffLevel !== undefined) {
    sets.splice(2, 0, "backoff_level = ?");
    params.splice(2, 0, backoffLevel);
  }
  getDb().prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/** A confirmed success clears the failure state; a no-op UPDATE when it is already clear. */
export function clearAccountFailure(id: string): void {
  getDb()
    .prepare(
      `UPDATE accounts
          SET backoff_level = 0, last_error = NULL, cooldown_until = NULL
        WHERE id = ? AND (backoff_level <> 0 OR last_error IS NOT NULL OR cooldown_until IS NOT NULL)`,
    )
    .run(id);
}

export function saveAccountQuota(id: string, quota: AccountQuota | null): void {
  getDb()
    .prepare("UPDATE accounts SET quota_json = ?, quota_fetched_at = ? WHERE id = ?")
    .run(quota ? JSON.stringify(quota) : null, Date.now(), id);
}
