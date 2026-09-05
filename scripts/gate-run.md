---
description: Start a gate agent workflow (offers the ones you have defined)
argument-hint: [workflow] [task…]
allowed-tools: Bash(__GATE_CLI__:*)
---

Workflows currently defined in gate — id, then name, description and the run input each one needs:

!`__GATE_CLI__ list`

The user asked for: $ARGUMENTS

Decide what to do with that:

- **It names or clearly matches one workflow above** — start it and follow it to the end:
  `__GATE_CLI__ run <id> --watch "<task text>"`, where the task text is everything the user
  wrote apart from the workflow name. If the workflow needs more than one input key, pass each
  one explicitly instead: `--input key=value`.
- **It is empty, ambiguous, or matches nothing** — show the workflows above in a short readable
  form (id, what it does, what it needs) and ask which one to run. Do not guess, and do not
  invent a workflow id that is not in the list.

A run works in its own git worktree on its own branch, so it never touches the checkout you are
in — starting one is safe even mid-task. A workflow whose input list includes `repo` works on the
directory the command is run from unless you pass `--input repo=/some/other/project`. When it finishes, report how it ended, the branch it
produced and the `git diff` command for it, then offer to review that diff.

If the run is still going when the watch stops, say so and give the execution URL rather than
claiming it finished.
