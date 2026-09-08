---
description: Run one of your team's gate workflows here, in this session
argument-hint: [workflow] [task…]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep
---

Workflows your team has defined — id, then name, description and the run input each one needs:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" list`

The user asked for: $ARGUMENTS

If that is empty, ambiguous, or matches nothing above, show the workflows in a short readable
form and ask which one to run. Do not guess, and do not invent an id that is not in the list.
If the list came back as an error, say what it said — `not connected` means this machine has
never been given a key, and `/gate:login <token>` with a token from the dashboard fixes it.

## How a run works

**You are the one running it.** gate decides *what* runs next and in *what order*; the work
itself happens here, in this session, with your own tools, where the user can see it and answer
you. There is no second Claude session and nothing headless.

Start it, then repeat until it says it is done:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" begin <workflow-id> "<task text>"
```

Each call prints one JSON instruction:

- **`{"do": "agent", …}`** — your turn. `prompt` is the whole brief; do that work.
  - **Say what you are doing first.** One line before you start — which node, which agent,
    and in a sentence what you are about to do — then keep the user posted as you go. They
    are watching this happen and the workflow's shape is not on their screen; a silent five
    minutes is the thing this whole command exists to stop.
  - **`workspace` is where you work.** It is a git worktree of this repository on its own
    branch — *not* the checkout the user is sitting in. Read, write and run commands **there**,
    with absolute paths under it. Never edit files outside it.
  - `tools` is what the agent file says this role needs. Treat it as the shape of the job — a
    role listing only reads is reviewing, not implementing — and stay inside it.
  - Ask the user if something is genuinely ambiguous or risky. That is the point of running
    here; a question is better than a guess nobody sees.
  - When the work is done, write the answer to a file and hand it back:
    ```
    node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" step <execution-id> <node-id> --output-file <file>
    ```
    `output.type: json` means the file holds **exactly** that JSON object — the keys in
    `output.schema`, nothing else, no prose, no code fence. A type ending in `?` is optional.
    If gate refuses it, the message says what did not match: fix the file and hand it back
    again. Do not redo the work.
  - `step` prints the next instruction, so carry straight on.
- **`{"do": "done", …}`** — the run is over. Report `status`, the `branch` and
  `git -C <workspace> diff` for reviewing it, then offer to review that diff.
- **`{"do": "failed", …}`** — a node failed. Report the node and the error as they came; do not
  retry the run or work around it.

If you need to see where a run is (after an interruption, or if you lose the thread):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" next <execution-id>` returns the current
instruction without changing anything.

## Two things gate does itself

**Command nodes** (`npm test`, `git commit`, …) are argv from the workflow file. gate runs them
and prints their output to the terminal; you never run them yourself and never see them as an
instruction.

**Routing** is gate's. Which node follows which, and which way a loop goes, comes from the
workflow's edges and the outputs you hand back — not from your judgement. Answer the node you
were given, honestly, and let it route.

The first time a workflow runs on this machine — or after the team edits it — `begin` lists the
commands it will run and asks for approval. That prompt needs a terminal, so if it stops with
"Refusing to run unattended without approval", tell the user what it wanted to run and let them
approve; pass `--yes` only if they say so.
