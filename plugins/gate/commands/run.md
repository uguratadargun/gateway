---
description: Run one of your team's gate workflows here, in this session
argument-hint: [workflow] [task…]
---

<!-- No allowed-tools on purpose: it restricts a command to the tools it lists,
     and this command is a whole pipeline. An implementer node has to run this
     project's real test command, a reviewer has to read whatever it needs, and
     any of them may need to ask the user something. Inheriting the
     conversation's tools is the point — the run gets the user's own
     permissions, which is what makes it answerable. -->

Workflows your team has defined — id, then name, description and the run input each one needs:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" list`

The user asked for: $ARGUMENTS

If that is empty, ambiguous, or matches nothing above, show the workflows in a short readable
form and ask which one to run. Do not guess, and do not invent an id that is not in the list.
If the list came back as an error, say what it said — `not connected` means this machine has
never been given a key, and `/gate:login <token>` with a token from the dashboard fixes it.

## Settle the brief before you start it

Treat this like any other request someone makes of you: read it, and if something material is
unsettled, **ask before starting** rather than after five nodes have run on a guess.

A run is expensive in a way an ordinary answer is not. The task text is copied into every
agent's prompt, so an ambiguity at the start is an ambiguity the planner, the implementer and
both reviewers all inherit — and by the time it shows up, there is a branch with the wrong
thing built on it. Two questions now are cheaper than that, and this is the moment the user is
still sitting here expecting to talk to you.

Ask when the answer would change what gets built:

- **Scope** — "bump the version" in a repo with three packages: which one, and does anything
  else move with it?
- **Behaviour** — what the change should actually do where the brief only says what to touch.
- **Where** — a workflow pinned to a repository this machine has no clone of, or a task that
  could mean either of two projects.
- **Done** — what counts as finished, when the pipeline has a test node and the project's tests
  do not cover this.

Use AskUserQuestion when the answers are a small set of choices; plain questions otherwise. Ask
them **together, once** — a run is not an interrogation, and three rounds of one question each
is worse than starting.

Do not ask when the brief already settles it, when the answer is discoverable by reading the
repository (read it), or when it is a detail the workflow's own agents decide. A clear
one-liner deserves a run, not a questionnaire.

Then fold what you learn into the task you pass to `begin` — the run input is what the
dashboard shows and what every agent reads, so it should say what was actually agreed, not
what was first typed.

## How a run works

**You are the one running it.** gate decides *what* runs next and in *what order*; the work
happens on this machine, where the user can see it. Which of you does a given node depends on
the agent's `executor`, exactly as it does on the server:

- `executor: gate` — the loop driving the run, which here is **you**: you do the node with your
  own tools, in front of the user, and you can ask them. The shipped `acceptance` node is one.
- `executor: claude-code` — a **spawned Claude Code on this machine, in the agent's own model**.
  A planner on GLM, an implementer on a local model: your session's model cannot stand in for
  that, so gate starts it as a worker and you follow it. The shipped planner, implementer and
  reviewer are these. They run unattended — they were told so — and do not ask; what needed
  settling was settled above, before the run, and the acceptance node asks at the end.

Start it, then repeat until it says it is done:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" begin <workflow-id> "<task text>"
```

Each call prints one JSON instruction:

- **`{"do": "agent", …}`** — your turn. `prompt` is the whole brief; do that work. `remember`
  restates the rules that matter for this node, including the exact `gate step` line that ends
  it — read it each time rather than working from memory of this message, which will be a long
  way back by the fifth node.
  - **Follow the skills the node names.** `skills` lists what this agent's definition says it
    works by, with the directory each one was pulled into; open its `SKILL.md` and do what it
    says. A skill named by an agent is part of the node, not something to reach for if it
    seems handy — and a skill that wants to talk to the user (a brainstorming pass asking what
    they actually want, say) should talk to them. That conversation is the reason this runs in
    their session at all; do not compress it into an assumption to get to the answer faster.
  - **Say what you are doing first.** One line before you start — which node, which agent,
    and in a sentence what you are about to do — then keep the user posted as you go. They
    are watching this happen and the workflow's shape is not on their screen; a silent five
    minutes is the thing this whole command exists to stop.
  - **`workspace` is where you work.** It is a git worktree of this repository on its own
    branch — *not* the checkout the user is sitting in. Read, write and run commands **there**,
    with absolute paths under it. Never edit files outside it.
  - `tools` is what the agent file says this role needs. Treat it as the shape of the job — a
    role listing only reads is reviewing, not implementing — and stay inside it.
  - **Ask the user when you need to.** A choice the brief does not settle, something that
    looks wrong, a destructive step, anything you would otherwise guess at — ask, and wait.
    This is their session: they are there, they can answer, and a question costs a minute
    where a wrong guess costs the rest of the run. The node's answer goes in a file, not in
    what you say, so asking never gets in the way of finishing it.
  - When the work is done, write the answer to a file and hand it back:
    ```
    node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" step <execution-id> <node-id> --output-file <file>
    ```
    `output.type: json` means the file holds **exactly** that JSON object — the keys in
    `output.schema`, nothing else, no prose, no code fence. A type ending in `?` is optional.
    If gate refuses it, the message says what did not match: fix the file and hand it back
    again. Do not redo the work.
  - `step` prints the next instruction, so carry straight on.
- **`{"do": "wait", …}`** — a node is running on its own, in its own model. `log` is where it
  writes what it is doing, one tool call per line. You do nothing for it: do not touch the
  worktree, do not do its work, do not answer for it. Run
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" wait <execution-id>
  ```
  in the foreground: it prints what the node has done since you last looked and returns on its
  own — with the next instruction when the node is over, or with `wait` again after about
  ninety seconds. Between waits, tell the user what the log shows, in a line or two, and run it
  again. A node can take an hour; that is the worker's hour, not yours.
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
