Status: done
Branch: main
Decisions: docs/decisions/0014-a-checkout-gate-cloned-goes-with-the-record.md
Design: docs/design/repositories.md — "Connecting one", "Forgetting one", Pitfalls

# Forgetting a repository, and connecting it back

## Goal

A repository removed from the Repos page and added again failed:

    /root/.gate/repos/ulak-desktop already exists; pick another id or remove it first

Forgetting deleted the record and left the checkout, including the ones gate
had cloned itself, so the id it was connected under became unusable — the
directory was nothing's, the page could not show it, and only a shell could
remove it. Forgetting had to actually free what it owned, and connecting had
to stop failing on a directory left by an older gate.

Out of scope: ending runs (that is `gate clean`), and anything about the
worktrees themselves.

## Approach

Ownership decides. `cloned` on the record has always meant "gate created it,
and so may delete it again" and nothing read it; `removeRepoCheckout` reads it
now, and additionally requires the root to still be `~/.gate/repos/<id>`. A
checkout somebody's path pointed at is never touched.

Worktrees are asked about, not assumed: `git worktree list --porcelain` in the
checkout is what would break, so a checkout with anything branched from it is
kept and the response names those worktrees.

Connecting takes over a directory that is already there when its origin's
canonical identity equals the source's, at whatever commit it stands on. A
directory holding a different repository is still refused, now naming both.

## What counted as done

- Forgetting a cloned repository removes its checkout and the same id
  connects again, with no manual `rm`.
- Forgetting a repository connected by path leaves the directory alone.
- A checkout with a worktree branched from it survives, and the answer says
  which worktrees held it.
- Connecting onto an existing checkout of the same repository succeeds without
  cloning; onto a different one it fails naming both.
- `npm test` and `npm run typecheck` clean.

## Notes

The first run of the new test failed on macOS and was right to: `git worktree
list` answers in real paths, so `/private/var/…` never equalled the root's
`/var/…`, every checkout looked held open, and nothing would have been removed
on a developer's machine. Paths are compared with symlinks resolved.
