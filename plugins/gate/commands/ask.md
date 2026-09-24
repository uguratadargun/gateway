---
description: Ask another team what their code does — answered from one fixed commit of their published branch, with files
argument-hint: <question…> --repo <host/owner/name> [--ref <branch>] [--commit <sha>] | --run <id>
allowed-tools: Bash(node:*), Bash(gate:*), Write, AskUserQuestion
---

The user asked: $ARGUMENTS

## What this is

Four teams, four repositories, one gate. This is how a person on one of them finds out what
another one's code actually does without waiting for somebody on that team to be awake.

The gate holds the other team's repository and fixes **one commit** of it; **you** read it, here,
on the user's own Claude login, through `gate source` — the files never land on this machine and
nothing can be written through it. The answer names the files it came from. That is the whole
contract: an answer that cannot point at a file and a commit is not an answer this command will
give.

## 1. Work out what to ask, and of what

`gate ask` needs two things: the question, and which repository at which version.

- **The repository** is `--repo <host/owner/name>` — the canonical name, as the Repos page and
  every decision in memory spell it. A connected repository's own id works too.
- **The version**, if the user was specific. `--ref <branch>` for a branch (resolved to the commit
  it points at *now*, once, and quoted back), `--commit <sha>` when they already have one, or
  `--run <id>` when what they mean is "the work that run did" — a run names its source better than
  a branch does, because gate verified what the remote held after it pushed.
- Unset version means the repository's own base branch. That is usually right.

If the user named a team rather than a repository ("ask desktop how they…"), find the repository:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" memory search "<the feature>"` prints decisions with
their teams, and the Repos page has the names. If it is still ambiguous, ask with AskUserQuestion —
asking the wrong repository produces a confident answer about the wrong codebase.

Ask one question at a time. "How does their sync work and what does their auth do" gets one review
of two half-answers; two asks get two.

## 2. Ask

    node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" ask "<question>" --repo <host/owner/name> [--ref <branch>]

When there is a source to read, it starts a run of the team's `ask` workflow and prints its first
instruction as JSON — the same protocol `/gate:run` drives:

- **`{"do": "agent", …}`** — your turn. `prompt` is the whole brief: the question, the commit, what
  memory holds, and the `gate source tree|grep|file <ask> …` commands the repository is read
  through. Where the prompt says `gate`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"`. Read
  with those commands only — the checkout you are standing in is a different repository — and say
  what you are reading as you go. When you have the answer, write it to `outputFile` in exactly the
  shape `output.schema` gives (JSON, nothing else), and hand it back with the `gate step` line in
  `remember`. `step` prints the next instruction.
- **`{"do": "done", …}`** — the run is over. Present the answer (below).
- **`{"do": "failed", …}`** or **`{"do": "stopped", …}`** — say what it said, as it came.

The first time the workflow runs on this machine, `ask` asks for approval; if it stops with
"Refusing to run unattended without approval", tell the user and pass `--yes` only if they say so.

## 3. Present what comes back

**An answer** ends with the repository and the commit it was read at — write it as
`— <repo> at <commit, 12 chars> (<ref>)`. Carry that through to whatever you do next: if you are
about to plan against it, the plan says which commit the behaviour was true of. Do not restate it
as "desktop does X" with no version — it is "desktop does X at `a1b2c3d`", and those are different
claims.

**`source_unavailable`** means there is nothing published to read yet, and it says what would fix
it — nearly always a branch somebody has not pushed. Tell the user exactly that, naming the branch.
It does **not** mean the feature was not built: the work may be sitting finished on a machine that
has not published. Never report it as "they have not done it".

**`absent`** (the run ends on *Not in the commit that was read*) is the same kind of statement,
narrower: at that one commit, under the names you searched, there was nothing. Work published
since, or on another branch, is not in the answer. If the user expects it to be there, ask again
with the branch they have in mind (`--ref`) before concluding anything.

**`gate has no repository called …`** — the name is wrong, or it is not connected to this gate, or
it belongs to a team outside yours. Those look the same from here on purpose. Check the spelling
against the Repos page first.

## Where this fits

It reads. It never changes another team's repository, and nothing it does is visible to them
beyond a fetch on the gate. If the answer is that their code has to change, that is an objection
or a task, not this command — `/gate:run` plans the change on your side, and the cross-team
objection protocol is how you tell them theirs is unworkable for you.
