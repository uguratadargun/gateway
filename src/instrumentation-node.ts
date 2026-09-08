/**
 * Node-only startup daemon: keeps every connected account's token warm by
 * refreshing it well before expiry so gateway requests never block on a cold
 * refresh, and settles any workflow run the previous process left open.
 * Imported only from instrumentation.ts under the nodejs-runtime guard.
 */
import { listAccounts } from "@/lib/accounts";
import { refreshStaleQuotas } from "@/lib/claude/usage";
import { loadSettings } from "@/lib/settings";
import { getValidCredentialsFor } from "@/lib/token-manager";

const g = globalThis as unknown as { __gateDaemon?: boolean };

if (!g.__gateDaemon) {
  g.__gateDaemon = true;

  const tick = async () => {
    try {
      // Every account, not just the preferred one: a pooled login is only
      // useful the moment the one before it hits its window, which is exactly
      // when there is no time for a cold refresh.
      await Promise.all(listAccounts().map((a) => getValidCredentialsFor(a.id)));
      // Quota too: the pool's quota floor and the throttle both read windows
      // that response headers only fill once traffic has flowed.
      await refreshStaleQuotas(loadSettings().accountPool.quotaRefreshMinutes);
    } catch {
      // best-effort; a failed refresh surfaces on the next real request
    }
  };

  setInterval(tick, 10 * 60 * 1000).unref?.();
  void tick();
}
