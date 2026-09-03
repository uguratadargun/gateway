import { refreshToken } from "./claude/oauth";
import { loadCredentials, saveCredentials, type StoredCredentials } from "./store";

/** Refresh when the token has less than this remaining (5 min). */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

let inflight: Promise<StoredCredentials | null> | null = null;

/**
 * Return valid credentials, refreshing proactively if the access token is near
 * expiry. Concurrent callers share a single refresh (no token-reuse races).
 */
export async function getValidCredentials(): Promise<StoredCredentials | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  if (creds.expiresAt - Date.now() > REFRESH_LEAD_MS) return creds;

  if (!inflight) {
    inflight = (async () => {
      const tokens = await refreshToken(creds.refreshToken);
      if (!tokens?.access_token) return creds; // keep old creds; upstream 401 will surface
      const updated: StoredCredentials = {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope ?? creds.scope,
        updatedAt: Date.now(),
      };
      saveCredentials(updated);
      return updated;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Force a refresh regardless of expiry (used after an upstream 401). */
export async function forceRefresh(): Promise<StoredCredentials | null> {
  const creds = loadCredentials();
  if (!creds) return null;
  const tokens = await refreshToken(creds.refreshToken);
  if (!tokens?.access_token) return null;
  const updated: StoredCredentials = {
    ...creds,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? creds.scope,
    updatedAt: Date.now(),
  };
  saveCredentials(updated);
  return updated;
}
