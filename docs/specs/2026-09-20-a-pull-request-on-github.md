Status: done
Branch: main
Decisions: docs/decisions/0024-the-remotes-host-opens-the-merge-request.md
Design: docs/design/dev-workflow.md

# The shipped pipelines open a pull request on GitHub

## Task

Asked: a run on the gate server could not open a pull request — install the
GitHub CLI on the server and whatever else it needs. The reading found two
causes, not one: `gh` was missing on the host, and the shipped pipelines only
ever spoke GitLab, so even with `gh` installed nothing would have opened it.

## Done

- The `merge-request` node picks its route from `git remote get-url origin`:
  `*github.com*` pushes and runs `gh pr create --fill --title "<first line of
  the task>"`, everything else keeps `glab mr create` when signed in and
  GitLab's push options when not. A GitHub remote with no signed-in `gh` fails
  the node with a message naming what to install, before the push, so a run
  cannot end with a branch on the remote and nothing pointing at it. Shared by
  `dev`, `dev-super` (derived from `dev`'s text) and `dev-quick`.
- `tests/defaults.test.ts` holds the node to both routes.
- The gate server has the GitHub CLI installed (`gh` 2.101, from GitHub's own
  apt repository) at `/usr/bin/gh`, inside the service's `PATH`, and the
  service runs as `gate` with `HOME=/var/lib/gate`. The sign-in did not
  persist: `~/.config/gh/hosts.yml` was left empty, so the node took its
  not-signed-in branch on every run after this one. Its git remotes were
  already reachable: the `gate` user's SSH key authenticates to GitHub as
  `uguratadargun`.
- `npm run defaults:restore -- --refresh` on the server, so the live gate's
  shipped workflows are the new ones. Runs already in flight keep the
  definitions they pinned when they began.

Run: `npx vitest run tests/defaults.test.ts` (51 passed), `npm run typecheck`,
`npm run docs:check` (clean), `npm test` (whole suite).
