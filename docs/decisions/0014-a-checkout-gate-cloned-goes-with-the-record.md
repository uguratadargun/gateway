# 0014. A checkout gate cloned goes with the record

Status: accepted
Date: 2026-09-16

## Context

Forgetting a repository deleted the record and deliberately left the checkout
on disk, even the ones gate had cloned itself, on the grounds that a run's
worktree might still branch from it. The reasoning was right about worktrees
and wrong about everything else: a repository is connected by URL, the id
defaults to the slug of that URL, and the clone lands at
`~/.gate/repos/<id>`. So forgetting a repository and connecting it again —
the ordinary way to fix a wrong base ref or a bad setup command — failed on
`/root/.gate/repos/ulak-desktop already exists; pick another id or remove it
first`. The directory was nothing's any more: no record named it, the page
could not show it, and only a shell could remove it. The id was single use,
and the person was told to pick another one, which is how a gate ends up with
`ulak-desktop-2`.

## Decision

A checkout gate cloned is gate's to remove, and goes when the record does. A
checkout a path pointed at is never touched, and a checkout a worktree still
branches from is kept and says which worktrees are holding it. Connecting
onto a directory that is already there takes it over when it is the same
repository, decided by its origin, and refuses it when it is not.

## Rationale

Ownership is the line, and the record already drew it: `cloned` has meant
"whether gate created it, and so may delete it again" since the column
existed. Nothing read it. Honouring it costs nothing and makes the dangerous
case — deleting somebody's working copy because they typed its path into a
form — impossible rather than unlikely.

The worktree objection is real but is not about the record. A run's worktree
is a real `git worktree`, so the checkout's `.git` is the only copy of that
worktree's history; removing it mid-run loses the branch and everything on
it. That is a question to ask the checkout, not a reason to keep every
checkout forever. `git worktree list` answers it exactly, and a checkout that
answers yes is kept — with the worktrees named, because `gate clean` is what
ends them and the person has to know which.

Adoption is what makes the id reusable rather than merely reclaimable.
Cloning the same URL a second time reproduces the commits already in the
directory, so refusing was never protecting anything; it only demanded a
different id. The refusal is kept for the case it was actually protecting
against — a directory holding a different repository, where a clone would
land this one on top of somebody else's work — and that is decided by the
canonical identity of the origin, the same rule the rest of the repository
layer names things by, never by the directory's name.

Adoption is deliberately not a pull. The checkout is taken over at the commit
it stands on, because moving somebody's checkout is a thing they asked for
with the Pull button, not a side effect of reconnecting.

An adopted checkout with no remote, or one that is not a git checkout at all,
is refused rather than guessed at: unknown is never filled in from the path,
here as everywhere else.

## Alternatives

Keep leaving every checkout, and make the error message say "remove it
yourself". The person is still in a shell, in `~/.gate`, deleting a directory
by hand — and that is a worse place to be wrong than the code is.

Refuse to forget a repository whose checkout has worktrees. It makes the
common case fail for the uncommon one: the record is small, the person wants
it gone, and holding the list hostage to a stale worktree helps nobody.

Force it: remove the worktrees too. Those are runs, with uncommitted work and
unpublished branches. `gate clean` ends a run, having judged whether its work
is safe to drop; a repository page has not judged anything.

Remove the orphaned directory on connect and clone fresh. It reaches the same
end state, but makes connecting a destructive operation — and connecting is
what somebody does by typing a URL into a form and pressing a button.

## How it works

`removeRepoCheckout` in `src/repos/setup.ts` removes a checkout only when the
record says gate cloned it and the root is still `~/.gate/repos/<id>`; it asks
`heldWorktrees` first and keeps the directory, with a reason, when anything is
branched from it. Paths are compared with symlinks resolved, since git answers
in real paths and `/var` is a link to `/private/var` on macOS — comparing them
as written made every checkout look held open.

`DELETE /api/repos/[id]` calls it before deleting the record and answers with
`checkoutRemoved`, plus `checkoutLeftAt` and `keptBecause` when it is not. The
Repos page says which of the two will happen before confirming, and shows the
reason afterwards, since a checkout that outlived its record is the one thing
that page can no longer show.

`connectRepo` takes over an existing directory through `adoptCheckout`, which
compares `canonicalRepoId` of the directory's origin with the source's and
throws naming both when they differ.

## Consequences

Forgetting a cloned repository frees its disk, and the same id connects again
immediately. Forgetting one that was connected by path changes nothing on
disk, as before.

Past runs of a forgotten cloned repository lose their diffs and can no longer
be continued: `restoreRunWorkspace` needs the checkout, and it is gone. That
is the cost of forgetting, and the confirmation says the checkout goes.

A directory left by an older gate, before this record, is taken over the next
time its repository is connected instead of blocking the id forever.

## Touches

- `src/repos/setup.ts`
- `src/app/api/repos/[id]/route.ts`
- `src/app/repos/page.tsx`
- `tests/repo-forget.test.ts`
- repositories

## Supersedes

none
