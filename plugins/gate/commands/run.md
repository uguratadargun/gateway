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

If it is empty, show the workflows in a short readable form and ask which one to run. If it
starts with an id from the list, that is the workflow and the rest is the task. If it is a task
with no workflow named, **you pick the road** — the section after the brief says how — and do
not ask which workflow unless that section says to. Never invent an id that is not in the list.
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

## Pick the road, when the user did not

A task with no workflow named goes down one of two roads, and which one is your call: the
reading you just did to settle the brief is the reading that answers it, so decide now rather
than asking the user to. Say which road and why in one line before you start it — a run is
visible from the moment `begin` is called, and that line is what lets them stop a wrong pick
before it costs anything.

**The short road is `dev-quick`.** Take it only when all of these hold:

- the task adjusts something that already exists — a colour, a label, a default, a copy
  change, a small fix in behaviour that is already there;
- you can name the files it touches from the reading you did, and there are one or two of
  them;
- it needs no design: no new surface (a screen, an endpoint, a command, a setting), no new
  behaviour that has to be chosen between ways of doing it, no migration, no change to a
  protocol, a schema or a public API, no new dependency;
- nothing is left for the user to decide once the brief is settled;
- the project's own check for those files is the whole of what verifies it.

**The long road is the team's own pipeline for this repository, when it has one**: a workflow
in the list above that is not one of the shipped three (`dev`, `dev-super`, `dev-quick`), takes
a `task`, and works in a git worktree — `/gate:design` builds those around this project's own
codegen, test command and merge-request host, and that is what a real change here should run
through. If there is more than one such workflow, ask which, once. If there is none, the long
road is `dev`. `dev-super` is never picked on your own: it runs when the user names it.

Any condition of the short road that does not hold sends the task down the long road. When
it is genuinely on the line — the files are two but one is shared by half the app, the fix is
small but the behaviour is not settled — ask once, with AskUserQuestion, both roads as the
options and your recommendation first with its reason in one line; put that question in the
same round as any brief questions you have, never a round of its own.

The picks are not symmetric, and the pipeline knows it: a task that turns out not to be small
ends `dev-quick` at its `nothing-changed` terminal with the implementer's reason in the
summary, in minutes, before anything is half-built. When a run you sent down the short road
ends that way — the summary says the task needs a plan, a design, or touches more than a quick
pass should — start the long road with the same brief, plus one line saying what the quick
implementer found, without asking. Only that case: a `nothing-changed` that says the task was
already done, or that nothing needed changing, ends there.

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

**The run reads the team's memory first, and writes to it last.** The shipped pipelines open
with a `recall` node: it searches what earlier runs decided — across the team's whole tree, so a
feature the android team built is found when desktop is asked for it — and briefs the planner,
with ids. In your session that node is yours to do (`executor: gate`), and its tools are
commands: `gate memory search "<words>"`, `gate memory search --path <prefix>`,
`gate memory feature <id>`. Run them, read what they print, write the brief; a brief that says
memory holds nothing is a real answer. When the run ends — however it ends — the server's
recorder reads its steps and writes what was decided, why and how; nothing you do here writes
memory, and the run's page on the dashboard shows what was recorded.

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
    role listing only reads is reviewing, not implementing — and stay inside it. An empty list
    is a node that is a conversation with the user and nothing else (the shipped `clarify`):
    no files, no commands, just the asking.
  - **Ask the user when you need to.** A choice the brief does not settle, something that
    looks wrong, a destructive step, anything you would otherwise guess at — ask, and wait.
    This is their session: they are there, they can answer, and a question costs a minute
    where a wrong guess costs the rest of the run. The node's answer goes in a file, not in
    what you say, so asking never gets in the way of finishing it.
  - **But never stop a run for something the pipeline has already decided.** What the
    pipeline's own nodes do next — stage, commit, open the merge request, which files the
    commit takes — is the workflow's, settled when it was written, and not a question for
    the middle of a run. A preference you remember about the user (which files they like
    committed, how they name branches) is something to mention when the run is over, not a
    reason to hold a node: measured here, a reviewer's approval waited thirty-four minutes
    on "shall I take the plan file out of the commit?" while the user was away. Hand the
    step back, then say what you noticed.
  - **No signature on any commit.** A commit the run makes — a subagent's, a worker's, or
    one you make yourself for a node — carries no "Co-Authored-By" and no "Generated with"
    trailer, whatever your own habit is: the commit is the team's, and the tool that typed it
    is not its author. The shipped agents are told the same; if you see one on the branch,
    say so at the end rather than rewriting history mid-run.
  - **`gate step` is final.** What you hand back becomes the node's output, the edges are
    taken on it, and there is no way to take it back: the next nodes read it as the truth.
    So never hand back a test, a placeholder or a minimal output to see whether the command
    works — measured here, `{"plan":"x","planFile":"y"}` sent to find out why a real output
    was refused advanced the run past its plan with nothing in it. If `step` refuses your
    file, keep the file, read the message, and fix the file or say what it said; do not
    experiment on a live run.
  - **A node that exists to ask them pauses the run.** The shipped `clarify`, `plan-review`
    and `acceptance` nodes are the person's turn: while one is in your hands the dashboard
    shows the run as *paused* and its clock stands still, and `gate step` sets it running
    again. Nothing for you to do about it; take as long as they need.
  - When the work is done, write the answer to `outputFile` — a path under the run's own
    directory that gate has already made — and hand it back:
    ```
    node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" step <execution-id> <node-id> --output-file <outputFile>
    ```
    `output.type: json` means the file holds **exactly** that JSON object — the keys in
    `output.schema`, nothing else, no prose, no code fence. A type ending in `?` is optional.
    If gate refuses it, the message says what did not match: fix the file and hand it back
    again. Do not redo the work.
  - `step` prints the next instruction, so carry straight on.
- **`{"do": "delegate", …}`** — a node in its own model, to run as **your subagent** so the
  user watches it live: every read, every edit as a diff, every command, in this terminal.
  Start the subagent `subagent` names with the Agent tool, in the foreground, and give it
  `prompt` as its task — whole and unchanged — followed by what `remember` says to tell it:
  the worktree, the skill files to read first, the shape of its answer. Do not do the node
  yourself, and do not choose a model for it: the subagent's file carries the agent's own
  model, which is the point. It cannot ask the user, and you do not answer for it.
  - **It writes its own answer file.** The prompt already tells it to write its final JSON to
    `outputFile`. When it returns, hand that file back with the `gate step` line in
    `remember` — as it is, without opening it to retype it, and before you say anything to
    the user; the file is what the run reads, and the minute you would spend reproducing it
    is a minute the run stands still. Name the subagent on that line (`--subagent`, its
    agent id or name from the Agent tool's result) so the next pass can continue it. Only if
    the file is missing do you take the answer from its final message and write it there.
  - **A node's next pass continues the same subagent.** When `resume` names one, this node
    ran earlier in this run — a planner coming back with the person's answers, an
    implementer with a bounded fix — and that subagent still holds everything it read and
    decided. Continue it with SendMessage (`to` is `resume`, the message is `prompt` whole
    and unchanged) instead of starting a fresh one that reads it all again; the prompt
    carries what is new. If the send fails because the agent is gone, start `subagent` fresh
    with the Agent tool as on a first pass.
  - You only get this instruction when your session runs through the gateway (see the end of
    this file); otherwise the same node arrives as `wait`.
- **`{"do": "wait", …}`** — a node is running on its own, in its own model. `log` is where it
  writes what it is doing, one short line per thing done, the way you show your own tool
  calls: `⏺ Read src/a.ts`, `⏺ Edit src/a.ts (+2 −1)`, `⏺ Bash: Run tests`, and what it says
  in between. You do nothing for it: do not touch the worktree, do not do its work, do not
  answer for it. Run
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" wait <execution-id>
  ```
  in the foreground: it prints what the node has done since you last looked and returns on its
  own — with the next instruction when the node is over, or with `wait` again after about
  ninety seconds. A node that runs past its agent's `timeoutMs` is not stopped: the log says it
  is overrunning, you tell the user, and stopping it is their call (`gate cancel`, or Stop on
  the dashboard). **The user cannot see that command's output.** The node is working in their
  worktree, in a model they chose, and this log is their only view of it — so after every
  `wait`, relay the lines it printed, as they are, in one fenced code block: nothing added,
  nothing summarised, nothing left out. Then run `wait` again. A node can take an hour; that
  is the worker's hour, not yours.
- **`{"do": "done", …}`** — the run is over. Report `status`, the `branch` and
  `git -C <workspace> diff` for reviewing it, then offer to review that diff. A completed run
  whose every commit reached the remote has its worktree removed on the spot and says so —
  the branch stays, and `git checkout <branch>` in the user's own checkout brings the work
  back; anything unpushed or uncommitted keeps its worktree. `gate clean` lists and removes
  the worktrees older runs left behind, by the same rule.
- **`{"do": "failed", …}`** — a node failed. Report the node and the error as they came; do not
  work around it. The worktree and everything the run did before that node are kept, and
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" continue <execution-id>` reopens the run at
  that node, in the same worktree, without redoing what already ran — offer that, and run it
  only if the user wants the node tried again.
- **`{"do": "stopped", …}`** — the run was ended from outside while you were between calls:
  Stop on the dashboard, or written off after this machine went quiet for hours. Say so, with
  the error as it came, and do nothing further for it; a new run needs `begin`.

If you need to see where a run is (after an interruption, or if you lose the thread):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" next <execution-id>` returns the current
instruction without changing anything.

## Two things gate does itself

**Command nodes** (`npm test`, `git commit`, …) are argv from the workflow file. gate runs them
between two instructions and prints what they printed on the same channel as everything else
it says — which is **not** the user's screen: it is the output of the `gate` command you ran.
So when a `begin`, `step` or `next` came back with lines above its JSON — a `$ git diff …`,
a test suite's tail, a `✓ commit` — relay them to the user in a fenced code block before you
go on. You never run those commands yourself and never see them as an instruction.

**The run's definitions are pinned when it starts.** `begin` copies the team's agents,
workflows and skills as they are at that moment, and every later `next`, `step` and `wait`
of that run reads the copy — so an edit in the dashboard, or a `gate pull`, changes the next
run and never the graph under a run that is already walking it.

**Routing** is gate's. Which node follows which, and which way a loop goes, comes from the
workflow's edges and the outputs you hand back — not from your judgement. Answer the node you
were given, honestly, and let it route.

The first time a workflow runs on this machine — or after the team edits it — `begin` lists the
commands it will run and asks for approval. That prompt needs a terminal, so if it stops with
"Refusing to run unattended without approval", tell the user what it wanted to run and let them
approve; pass `--yes` only if they say so.

## Watching a node live

A node in its own model runs as your subagent — drawn live in this terminal — only when your
own session sends its model calls through the gateway, because a subagent inherits your
endpoint and its model is a name only the gateway resolves. `/gate:live` makes that so for
Claude Code started in this repository, through its own settings; nothing has to be typed
after that. If a run's nodes arrive as `wait` and the user asks to see them live, tell them
about `/gate:live` once. The first time, gate writes the team's agents to `~/.claude/agents/`;
if that directory did not exist before, Claude Code needs one restart to see them.
