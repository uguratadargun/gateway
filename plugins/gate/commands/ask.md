---
description: Ask another team what their code does — answered from one fixed commit of their published branch, with files
argument-hint: <question…> --repo <host/owner/name> [--ref <branch>] [--commit <sha>] | --run <id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" ask:*), AskUserQuestion
---

The user asked: $ARGUMENTS

## What this is

Four teams, four repositories, one gate. This is how a person on one of them finds out what
another one's code actually does without waiting for somebody on that team to be awake.

The answer comes from **one commit** of the other team's published branch, read by a review agent
that has no writing tools and no command tool, and it names the files it came from. That is the
whole contract: an answer that cannot point at a file and a commit is not an answer this command
will give.

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

It prints the commit it is reading, then waits for the review and prints the answer with its
sources. It can take a few minutes — the agent is reading their repository properly.

## 3. Read what comes back

**An answer** ends with the repository and the commit it was read at. Carry that through to
whatever you do next: if you are about to plan against it, the plan says which commit the
behaviour was true of. Do not restate it as "desktop does X" with no version — it is "desktop
does X at `a1b2c3d`", and those are different claims.

**`source_unavailable`** means there is nothing published to read yet, and it says what would fix
it — nearly always a branch somebody has not pushed. Tell the user exactly that, naming the branch.
It does **not** mean the feature was not built: the work may be sitting finished on a machine that
has not published. Never report it as "they have not done it".

**`nothing at that commit matched`** is the same kind of statement, narrower: at that one commit,
under the names the reviewer searched, there was nothing. Work published since, or on another
branch, is not in the answer. If the user expects it to be there, ask again with the branch they
have in mind (`--ref`) before concluding anything.

**`gate has no repository called …`** — the name is wrong, or it is not connected to this gate, or
it belongs to a team outside yours. Those look the same from here on purpose. Check the spelling
against the Repos page first.

## Where this fits

It reads. It never changes another team's repository, and nothing it does is visible to them
beyond a fetch. If the answer is that their code has to change, that is an objection or a task,
not this command — `/gate:run` plans the change on your side, and the cross-team objection
protocol is how you tell them theirs is unworkable for you.
