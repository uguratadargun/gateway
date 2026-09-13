---
description: Remove the worktrees finished runs left behind on this machine
argument-hint: [--all] [--dry-run]
allowed-tools: Bash(node:*)
---

First show what would go, without removing anything:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" clean --dry-run`

The user asked for: $ARGUMENTS

Every run works in its own worktree under `~/.gate/workspaces/<run-id>`, on a branch of its
own, so the user's checkout is never touched. A run removes its worktree itself when it ends —
completed, failed or stopped — after committing what it left uncommitted onto its branch. What
is still here is from runs before that, or runs that never got to end on this machine (a
session closed mid-run), and this is what removes them, the same way. **The branch is kept in
every case**: a worktree is a directory, the work is on the branch, and `git branch -D
<branch>` in the checkout is the user's own decision afterwards.

Read the dry run above and tell the user, in a line each, what it says: `would remove` is a
worktree whose run the gate says is over — anything uncommitted in it is committed onto its
branch before it goes — or one the gate has no record of that holds nothing that could be lost.
`keep` is a run that is still going, which is never removed, or a worktree the gate has no
record of that still holds commits or changes.

Then:

- If the user passed nothing, or `--dry-run`: stop here; nothing is removed.
- Otherwise run it for real, with `--all` if they gave it:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" clean [--all]

  Without `--all` only the `would remove` lines go. With `--all` the worktrees the gate has no
  record of go too, their uncommitted changes committed onto their branches first.

Report what it printed.
