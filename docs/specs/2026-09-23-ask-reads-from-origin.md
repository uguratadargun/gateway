Status: done
Branch: fix/ask-reads-base-from-origin
Decisions: docs/decisions/0044-a-repository-that-does-not-publish-is-read-from-its-origin.md
Design: docs/design/cross-team.md, docs/design/repositories.md

# `gate ask` reads a repository that does not publish from its origin

## What was asked

An android developer ran `gate ask` about how the desktop app handles sync messages and got `"ulak-desktop" does not publish, so nothing in it can be read from here — give it a publication remote on the Repos page`. Meanwhile the desktop developer got correct answers in their own checkout. Find out why, and do what is needed.

## What was found

- The desktop developer's answers never went through `ask`. The live gate had no ask run at all. Their session read the files in its own checkout and the record index's documents.
- `ulak-desktop` has no publication remote on the live gate, which is the default. `resolveAskSource` refused any repository without one before reading anything.
- The record index reads the same repository's base branch from `origin` when there is no publication remote. It had read `master` at `f189b925` minutes earlier. The two reads disagreed about the same branch.

## What was done

- `readRemote` in the repository store: the publication remote, or `origin`. Both `ask` and the record index use it.
- `ask` of a branch, a tag or a commit no longer needs a publication remote. `ask --run` still needs the run to have been published.
- Tests: a repository with no publication remote is resolved at its origin's commit, and a checkout with no origin is refused naming the repository and the remote.

## What counted as done

- `npx vitest run tests/ask.test.ts` passes, and the two new tests fail against the old `ask.ts`.
- `npm test`, `npm run typecheck` and `npm run docs:check` pass.
- On the live gate, after a redeploy, `gate ask … --repo gitlab.ordulu.com/ulak-genel/desktop/ulak-desktop` resolves to a commit instead of refusing.
