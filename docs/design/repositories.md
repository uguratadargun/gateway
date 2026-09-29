# Repositories

## Summary

A project is connected once: where the gate's checkout of it is, what to
install in that checkout, whose it is, and where finished branches go. A
workflow can then name it rather than a typed path, and each person says once
which of their own clones it is. Every clone of a project answers to one name, so what a team learns about a file is
filed against the project that file is in, never against a same-named file
elsewhere. When a run finishes, its branch is pushed where another machine can
fetch it, or the reason it was not is reported as itself.

## How it works

### The one name

A repository's identity is its git remote, normalised to `host/owner/name`.
Two clones on two machines agree because each reads it off its own origin, and
the remote is the only part of a checkout a second machine can use. Where the
remote does not say — a local path, a `file://` URL, a remote with no owner, a
host without a dot — the identity is unknown, and unknown is never filled in
from the path or the slug.

The name is read off the checkout, never off what was typed, and it is set
once. A record refuses an identity that disagrees with the one it holds and
names both, for a person to resolve. Losing a remote revokes nothing, and a
repository connected before it had a name is named at startup, by asking its
checkout for its origin.

### Whose it is

A repository belongs to a team, or to nobody. The team is what another team's
question is measured against: only that team and the teams in its tree may ask
about the code. Nobody is the wider setting rather than the safer one — a
repository nobody has claimed is readable by anyone who can reach this gate,
because that is what every repository connected before the column existed
already was, and treating unset as everyone's secret would hide them all with
no way to tell which should have been.

It is said where the repository is, on the Repos page: at connect time, and on
the record afterwards, applied as it is chosen. An owner that names no team is
refused rather than stored — it would put the repository outside every asker's
family while reading, in the one field that decides access, as though it had an
owner.

### Connecting one

A source is a path or a URL, decided by its shape. A URL is cloned under
gate's own directory, as the user, with the credentials the shell would use; a
path has to exist and be a git repository. Setup commands, run once in the
checkout, are guessed from the lockfile and the manifest and prefilled into
the form — a starting point, not a verdict. Inspecting is offered for paths only: reading a URL would cost a
clone nobody asked for.

A repository is new, installing, ready or failed, and the tail of its setup
log stays on the record. A pull fast-forwards only — this checkout is shared
by the record index and every team's questions and is no place to resolve a
merge — then runs setup again.

The gate's checkout is read, never worked in. The [record index](record-index.md)
reads its base branch, and another team's question fetches into it and reads
one commit with git; no run's worktree is cut from it.

A checkout already standing where the clone would go is taken over, not
refused, when its origin says it is the same repository — at the commit it
stands on, since moving somebody's checkout is what the pull button is for. A
directory holding anything else, or nothing git can read, is refused and both
names are said: cloning into it would land this repository on top of another's
work.

### Forgetting one

A checkout gate cloned goes with the record. A checkout a path pointed at is
somebody's own working copy and is never touched, and the confirmation says
which of the two will happen before it does. A checkout a worktree still
branches from is kept whatever else is true — that `.git` is the only copy of
the worktree's history — and the worktrees holding it are named. The work of
runs is on the machines that did it and on their branches, so forgetting a
repository takes none of it.

### What a run gets

A run works on the person's own machine, in a worktree cut from their own
clone at the base ref. A workflow that names a connected repository's id can
only mean whichever clone of it this person keeps, mapped once with `gate
repo`; a workflow that names none works in the repository the person is
standing in. The clone's installed dependencies (`node_modules`, `vendor`,
`.venv`) are linked into the worktree, and nothing else is run before the
first node. The run records the repository's name, which is what makes its
memory mean this codebase: the client reports its origin and the server
derives the name, so every client names a repository identically.

### Publishing

A repository publishes only if it names a publication remote; nothing does by
default. A branch policy says which branches that covers, as a glob: `gate/*` by
default, `*` read as `**`, empty meaning never.

The push happens on the person's machine, which holds the worktree; the
gate's own checkout is never pushed from. Nothing is forced, no upstream is set.
Afterwards the remote is asked what it holds, and the push counts only when
the remote reports the very commit that was pushed; that reported commit is
what is recorded, so nothing is recorded that another team cannot fetch. A
remote whose fetch URL answers with another commit — a separate push URL, a
mirror that lags — is a push that is not verified. A failed push is reported as itself and leaves the
run's result alone: built and fetchable are separate claims. Mid-run, `gate
publish` commits the worktree as a checkpoint that says so in its own message,
leaving out the borrowed dependency links the repository does not already
ignore, then pushes the same way. Work never pushed is unreachable to another team's
question, and is answered as unreachable rather than never built.

Publishing is about pushing, not reading. A repository that names no
publication remote is still read, from its `origin`, by another team's
question and by the record index.

## Key files

- `src/repos/identity.ts` — the canonical name: what a remote parses to, what is refused, when two remotes are one
- `src/repos/store.ts` — the record, the identity that cannot move, whether this repository publishes, and which remote it is read from
- `src/repos/detect.ts` — guessing setup; which directories a worktree borrows
- `src/repos/setup.ts` — connecting, cloning, setup, pull, forgetting, naming repos registered before names
- `src/repos/publish.ts` — the branch policy, the verified push, the mid-run checkpoint
- `src/app/api/repos/` — connect, inspect, edit, forget, re-run setup, pull
- `src/app/repos/page.tsx` — where the detected setup is edited before running, and whose repository it is
- `src/orchestration/ask.ts`, `src/orchestration/ask-source.ts` — what the team on the record is measured against when another team asks, and the reads of the checkout at one commit
- `src/client/repo.ts`, `src/runtime/workspace.ts` — which clone a run works in, its worktree and the dependencies it borrows
- `src/client/release.ts`, `src/client/cli.ts` — the end-of-run push, `gate repo`, `gate publish`
- `src/app/api/v1/executions/route.ts` — naming a client's repository from the origin it sends

## Pitfalls

- An ssh_config alias (`git@github-work:…`) has no dot in its host, so it is not a name; the repository stays unknown until origin names a real host.
- Unknown is not a name: two repositories nobody could identify never match, and memory under either stays unqualified.
- A checkout with no remote has no name, and nothing fills it in — not the slug, not the display name.
- Repointing a checkout's origin at another project is refused, not migrated; the two names are reported and a person decides.
- A repository with no team is readable by every team on this gate; narrowing it is an act, not the default.
- The publication target is read fresh on every `gate next`, as `gate publish` reads it, so a remote named or removed mid-run decides where that run's final push goes.
- A worktree borrows its clone's dependencies as they are. A clone whose lockfile moved and was not reinstalled lends the run dependencies that no longer match the code, and generated files that git does not track are not in the worktree at all.
- A checkout with worktrees branched from it survives forgetting; the record goes, the directory stays, and the answer names what is holding it.
- Paths from `git worktree list` are real paths, so they are compared with symlinks resolved — as written, `/var` and `/private/var` made every checkout look held open.

## Decisions

- [0048 — A question to another team is read on the asker's machine, from the commit the gate fixed](../decisions/0048-ask-is-read-on-the-askers-machine.md)
- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0044 — A repository that does not publish is read from its origin](../decisions/0044-a-repository-that-does-not-publish-is-read-from-its-origin.md)
- [0014 — A checkout gate cloned goes with the record](../decisions/0014-a-checkout-gate-cloned-goes-with-the-record.md)
- [0012 — A push is verified against the remote, and a failed one is not a failed run](../decisions/0012-a-push-is-verified-against-the-remote.md)
- [0007 — A repository is named by its remote, and unknown is never guessed](../decisions/0007-a-repository-is-named-by-its-remote.md)
- [0003 — Ask answers from one commit](../decisions/0003-ask-answers-from-one-commit.md)
