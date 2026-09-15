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

  // An answer a person gave can outlive the process that took it: it is kept
  // the moment it arrives, even when the objection it settles has not been
  // reported yet. If that objection landed in a later batch — or in one this
  // process is only now reading — nobody else would ever go back and match
  // them up, so the sweep runs once at startup.
  void import("@/executions/record")
    .then((m) => {
      const { settled, waiting } = m.reconcilePendingApprovals();
      if (settled || waiting) console.log(`gate: ${settled} held answer(s) matched to their objection, ${waiting} still waiting`);
    })
    .catch((e) => console.error("[gate] could not settle held answers:", e));

  // Repositories registered before identity existed carry none. Each checkout
  // is asked what its own origin is — the same question connecting asks — so
  // nothing here is inferred from a path or a name. One that cannot answer
  // stays unknown, which for it is the true answer.
  void import("@/repos/setup")
    .then((m) => {
      const { named, unknown, disagreed } = m.backfillRepoIdentities();
      if (named || unknown) console.log(`gate: ${named} repo(s) named by their remote, ${unknown} without one`);
      for (const d of disagreed) console.error(`[gate] repo identity disagrees with its remote — ${d}`);
    })
    .catch((e) => console.error("[gate] could not read repo identities:", e));

  // The Telegram bot, when a token is configured: people's questions,
  // approvals and new runs from their own chat. Loaded lazily so a gate
  // without one never pulls the remote-session code in at startup.
  void import("@/telegram/runtime")
    .then((m) => m.startTelegram())
    .catch((e) => console.error("[gate] telegram bot did not start:", e));
}
