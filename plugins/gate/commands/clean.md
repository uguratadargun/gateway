---
description: Remove the worktrees finished runs left behind on this machine
argument-hint: [--all] [--dry-run]
allowed-tools: Bash(node:*)
---

First show what would go, without removing anything:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" clean --dry-run`

The user asked for: $ARGUMENTS

Every run works in its own worktree under `~/.gate/workspaces/<run-id>`, on a branch of its
own, so the user's checkout is never touched. A run that ended by opening its merge request
removes its worktree itself; the rest accumulate — a run that failed, one that was cancelled,
one the person never answered — and this is what removes them. **The branch is kept in every
case**: a worktree is a directory, the work is on the branch, and `git branch -D <branch>` in
the checkout is the user's own decision afterwards.

Read the dry run above and tell the user, in a line each, what it says: `would remove` is a
worktree whose every commit is on the remote or which holds nothing past its starting commit;
`keep` is one with commits not on any remote, or with uncommitted changes, and the line says
which. `running` is a run that is still going and is never removed.

Then:

- If the user passed nothing, or `--dry-run`: stop here; nothing is removed.
- Otherwise run it for real, with `--all` if they gave it:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" clean [--all]

  Without `--all` only the `would remove` lines go. With `--all` every worktree whose run is
  not running goes too, unpushed commits and uncommitted changes included — those are still on
  their branches, but the uncommitted changes are gone for good, so if the dry run listed any
  `has uncommitted changes` lines and the user did not explicitly ask for `--all`, say so and
  ask before running it.

Report what it printed.
