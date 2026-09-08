import {
  getAccount,
  listAccounts,
  loadAccountCredentials,
  saveAccountCredentials,
  type Account,
} from "./accounts";
import { refreshToken } from "./claude/oauth";
import type { StoredCredentials } from "./store";

/** Refresh when the token has less than this remaining (5 min). */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/** One in-flight refresh per account, so concurrent callers never race a rotation. */
const inflight = new Map<string, Promise<StoredCredentials | null>>();

function rotate(creds: StoredCredentials, tokens: { access_token: string; refresh_token: string; expires_in: number; scope?: string }): StoredCredentials {
  return {
    ...creds,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? creds.scope,
    updatedAt: Date.now(),
  };
}

/**
 * Credentials for one account, refreshed proactively when the access token is
 * near expiry. Concurrent callers on the same account share a single refresh.
 */
export async function getValidCredentialsFor(accountId: string): Promise<StoredCredentials | null> {
  const creds = loadAccountCredentials(accountId);
  if (!creds) return null;
  if (creds.expiresAt - Date.now() > REFRESH_LEAD_MS) return creds;

  const existing = inflight.get(accountId);
  if (existing) return existing;

  const run = (async () => {
    const tokens = await refreshToken(creds.refreshToken);
    // Keep the old credentials on a failed refresh: an upstream 401 will
    // surface the real problem, and dropping them here would take a working
    // account out of the pool on a transient network blip.
    if (!tokens?.access_token) return creds;
    const updated = rotate(creds, tokens);
    saveAccountCredentials(accountId, updated);
    return updated;
  })().finally(() => {
    inflight.delete(accountId);
  });
  inflight.set(accountId, run);
  return run;
}

/** Force a refresh regardless of expiry (used after an upstream 401). */
export async function forceRefreshFor(accountId: string): Promise<StoredCredentials | null> {
  const creds = loadAccountCredentials(accountId);
  if (!creds) return null;
  const tokens = await refreshToken(creds.refreshToken);
  if (!tokens?.access_token) return null;
  const updated = rotate(creds, tokens);
  saveAccountCredentials(accountId, updated);
  return updated;
}

/**
 * The account gate's own utility calls use — token counting, the difficulty
 * grader, the model catalogue, the health probe. These are not client traffic,
 * so they take the highest-priority enabled account and ignore pool rotation.
 */
export function preferredAccount(): Account | null {
  return listAccounts().find((a) => a.enabled) ?? listAccounts()[0] ?? null;
}

export interface ActiveCredentials extends StoredCredentials {
  accountId: string;
}

export async function getValidCredentials(): Promise<ActiveCredentials | null> {
  const account = preferredAccount();
  if (!account) return null;
  const creds = await getValidCredentialsFor(account.id);
  return creds ? { ...creds, accountId: account.id } : null;
}

/** Force-refresh the preferred account (health endpoint). */
export async function forceRefresh(): Promise<StoredCredentials | null> {
  const account = preferredAccount();
  return account ? forceRefreshFor(account.id) : null;
}

/** Re-read one account after a refresh, for callers that hold the row. */
export function reloadAccount(accountId: string): Account | null {
  return getAccount(accountId);
}
