/**
 * Node-only startup work: settles what the previous process left open, and
 * keeps the record index reading connected repositories on its interval.
 * Imported only from instrumentation.ts under the nodejs-runtime guard.
 */
import { loadSettings } from "@/lib/settings";

const g = globalThis as unknown as { __gateDaemon?: boolean };

if (!g.__gateDaemon) {
  g.__gateDaemon = true;

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

  // The record index: every connected repository's base branch, read on the
  // interval Settings names (memory.indexEveryMinutes), checked once a minute
  // so a changed interval takes effect without a restart. Code and git only;
  // its cost is a fetch per repository.
  const recordTick = async () => {
    try {
      const minutes = loadSettings().memory.indexEveryMinutes;
      if (!minutes) return;
      const m = await import("@/memory/record-index");
      if (!m.recordIndexDue(minutes * 60_000)) return;
      const outcomes = await m.indexAllRepos();
      const failed = outcomes.filter((o) => !o.ok);
      for (const f of failed) console.error(`[gate] record index — ${f.repo}: ${f.error}`);
      // What was just read gets its vectors when there is a model to make them.
      await (await import("@/memory/hybrid")).embedMissing().catch(() => 0);
    } catch (e) {
      console.error("[gate] record index:", e);
    }
  };
  setInterval(recordTick, 60_000).unref?.();
  setTimeout(recordTick, 30_000).unref?.();
}
