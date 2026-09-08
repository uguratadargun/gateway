---
description: Run one of your team's gate workflows here, on this machine
argument-hint: [workflow] [task…]
allowed-tools: Bash(node:*)
---

Workflows your team has defined — id, then name, description and the run input each one needs:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" list`

The user asked for: $ARGUMENTS

Decide what to do with that:

- **It names or clearly matches one workflow above** — start it and follow it to the end:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" run <id> "<task text>"`, where the task text is
  everything the user wrote apart from the workflow name. If the workflow needs more than one input
  key, pass each one explicitly instead: `--input key=value`. The command prints each node as it
  runs and only returns when the run is over — do not poll it, and do not add `--quiet` unless the
  user asked for less output.
- **It is empty, ambiguous, or matches nothing** — show the workflows above in a short readable
  form (id, what it does, what it needs) and ask which one to run. Do not guess, and do not invent
  a workflow id that is not in the list.
- **The list came back as an error** — say what it said instead of guessing. `not connected` means
  this machine has never been given a key: the user creates one in their gate dashboard and runs
  `gate login --url <gate-url> --key <key>` once. An invalid or revoked key says so.

The run happens **here**, in this terminal: the engine, the agents' tools and any command nodes all
execute on this machine, in a fresh `git worktree` of this repository on its own branch, so the
checkout you are working in is never touched. Only the model calls go to the gate server, on the
user's own API key, which is what meters and routes them.

The first time a workflow runs on this machine — or after the team edits it — the command lists the
commands it will run and asks for approval. That prompt needs a terminal, so if the run stops with
"Refusing to run unattended without approval", tell the user what it wanted to run and let them
approve it; pass `--yes` only if they say so.

When it finishes, report how it ended, the branch it produced and the `git diff` command for it,
then offer to review that diff.
