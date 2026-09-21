import { getAccount } from "./accounts";
import { getKey } from "./apikeys";
import { INTERNAL_KEY_ID, LOCAL_KEY_ID } from "./gate-auth";
import { getProvider } from "./providers";
import { getUser } from "./teams";

import type { ActivityEvent, ActivityEventOut } from "./activity";

/**
 * The two naming ladders shared by `/traffic` and the live feed. `readTraffic`
 * feeds them a row its own `LEFT JOIN` already resolved; the SSE route has only
 * loose ids, so `nameCaller` does the same small lookups the join would have
 * done, one at a time. Decision 0017's rule — ids at write time, names at read
 * time — holds here too: this runs in the dashboard's own request, never on
 * the gateway's hot path.
 */

export interface CallerIds {
  keyId?: string | null;
  userId?: string | null;
  accountId?: string | null;
  providerId?: string | null;
}

/** The person behind the key, named as /team names them. */
export function callerLabel(r: any): string {
  if (r.user_name) return r.user_name;
  if (r.user_email) return r.user_email; // a person with no name set
  if (r.key_name) return r.key_name; // a key with no owner
  if (r.key_id === LOCAL_KEY_ID) return "local";
  if (r.key_id === INTERNAL_KEY_ID) return "workflow";
  if (r.key_id) return `key ${r.key_id}`; // the key went with its owner
  return "unknown"; // written before the log named its callers
}

/** Never meaningless: the Claude account, else the provider that answered. */
export function servedByLabel(r: any): string {
  if (r.account_label) return r.account_label;
  if (r.account_id) return `removed account ${String(r.account_id).slice(0, 8)}`;
  if (r.provider_label) return r.provider_label;
  if (r.provider_id) return `removed provider ${String(r.provider_id).slice(0, 8)}`;
  return "—";
}

/**
 * The two labels for loose ids, looked up one row at a time. Never called on
 * the gateway's request path — only from the dashboard's own reads.
 */
export function nameCaller(ids: CallerIds): { caller: string; servedBy: string } {
  const user = ids.userId ? getUser(ids.userId) : null;
  const key = ids.keyId ? getKey(ids.keyId) : null;
  const account = ids.accountId ? getAccount(ids.accountId) : null;
  const provider = ids.providerId ? getProvider(ids.providerId) : null;
  return {
    caller: callerLabel({
      user_name: user?.name ?? null,
      user_email: user?.email ?? null,
      key_name: key?.name ?? null,
      key_id: ids.keyId ?? null,
    }),
    servedBy: servedByLabel({
      account_label: account?.label ?? null,
      account_id: ids.accountId ?? null,
      provider_label: provider?.label ?? null,
      provider_id: ids.providerId ?? null,
    }),
  };
}

/**
 * An activity event with its ids resolved to the same two labels. `cache`
 * memoises within one stream connection, keyed on the id combination and
 * holding the pair JSON-encoded — a live feed replays the same few callers on
 * nearly every event, and a label may itself contain the separator a naive
 * join would need.
 */
export function namedEvent(e: ActivityEvent, cache: Map<string, string>): ActivityEventOut {
  const key = `${e.keyId ?? ""}|${e.userId ?? ""}|${e.accountId ?? ""}|${e.providerId ?? ""}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = JSON.stringify(
      nameCaller({ keyId: e.keyId, userId: e.userId, accountId: e.accountId, providerId: e.providerId }),
    );
    cache.set(key, hit);
  }
  const { caller, servedBy } = JSON.parse(hit) as { caller: string; servedBy: string };
  return { ...e, caller, servedBy };
}
