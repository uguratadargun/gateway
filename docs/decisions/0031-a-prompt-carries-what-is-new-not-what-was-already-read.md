# 0031. A prompt carries what is new, not what was already read

Status: accepted
Date: 2026-09-21
Run: manual

## Context

Two places in a run were sending a model text it already had.

The first is a node's second pass. Decision 0028 settled that a continued
pass goes back to the same subagent, addressed by its agent id, so that it
still holds the worktree it read and the reasoning it did. The prompt sent
to it was built by `prepareAgentNode` exactly as on a first pass: the
agent's whole body with every declared input rendered into it. On a
measured `dev-auto` run, an implementer's second pass was sent the task,
the plan, the plan file's path and the review that sent it back — of which
one was new. The rest was several thousand tokens of text already in the
conversation, and it reads as an instruction: a subagent handed its
original brief again starts the node over, re-reads the worktree and
re-derives what it had already decided.

The second is the `diff` node. It runs `git diff <base>` and its stdout
becomes `outputs.diff.stdout`, read by an edge that asks whether it is
empty and by the reviewer, which declares it as an input. On a real branch
that is the entire change, pasted through a node's output into a prompt —
while the reviewer is a Claude Code with the worktree in front of it and
`git` in its hands.

## Decision

A prompt carries what is new since the reader last saw it.

A continued pass is sent a delta: gate reconstructs the node's inputs as
they stood at its previous visit, compares them to the inputs now, and the
prompt is the paths that differ, each under its own heading, prefaced by
which pass this is and an instruction not to start over. When nothing
differs, the whole prompt is sent, as before. `gate next <execution-id>
--full` asks for the whole prompt deliberately.

The `diff` node takes `--stat`. Its job is to say whether anything was
built and in what shape; the reviewer runs its own `git diff` inside its
own node.

## Rationale

The subagent is the state. That is the whole point of 0028 — the id is
kept so the conversation is kept — and a system that keeps a conversation
and then replays its opening turn into it is paying for the conversation
twice and getting a worse answer for the money. The delta is not a
compression of the prompt; it is the prompt the situation actually calls
for.

Diffing the **declared inputs** rather than the rendered prompt text is
what makes this safe to do automatically. An input path is a named thing
the agent asked for; a difference in one is a fact about the run, not about
string formatting. A textual diff of two rendered prompts would report
noise from re-rendering and would have to be guessed at.

`--stat` is the same argument at the other end. A reviewer that reads the
diff from its own `git diff` reads it with the files around it and can
follow anything it wants; a reviewer handed the diff as text reads a
snapshot it cannot ask questions of, and the run paid to carry it there.

`--full` exists because the delta rests on an assumption the client cannot
verify: that the subagent is alive and remembers. When it is not — the
session restarted, the agent is gone, the send failed — there has to be a
way back, and it has to be one line the session can run without
understanding the machinery.

## Alternatives

**Summarise the previous pass instead of diffing inputs.** A model-written
summary of what the subagent already knows, sent to the subagent that knows
it. It costs a model turn, it can be wrong, and the thing it summarises is
already in the conversation.

**Send the delta always, with no full prompt at all.** Then a lost subagent
is a lost node: a fresh agent started with only "what is new" has no task.
The first pass and the recovery path both need the whole brief.

**Drop the diff node's output from the reviewer's inputs entirely.** The
edge that routes on an empty diff needs something to read, and the reviewer
being told the shape of the change before it starts is worth the line it
takes. `--stat` keeps both and pays for neither.

**Keep the full diff and let the reviewer ignore it.** It cannot: the text
is in its prompt whether it reads it or not, and a large one crowds out the
instructions around it.

## How it works

`src/client/step.ts`, on a `delegate` instruction where `resume` names a
subagent and `--full` was not given:

1. `outputsBeforePreviousVisit` finds the last step recorded for this node
   before the current position, then folds the outputs of every step before
   that one into an outputs map — skipping `condition` and `parallel`
   nodes, the same way `walk.ts` builds state. It returns `null` if the
   node has never run, which is the guard against a first pass being
   treated as a resume.
2. `prepareAgentNode` is run a second time against that reconstructed
   state, giving the resolved inputs as they were on the previous pass.
3. `resumePrompt` walks the node's declared input paths, strips a trailing
   `?`, and reads each from both resolved trees. A path is skipped when its
   value now is undefined, an empty string or an empty array, or when its
   `JSON.stringify` matches the previous value. If nothing is left it
   returns `null` and the full prompt is used.
4. The delta prompt names the pass and the node, says that everything from
   last time still holds and not to start over, then lists each changed
   path under a `##` heading. It is followed by the same answer-file notice
   a first pass gets, so the node still knows where to write.

Anything thrown while reconstructing gives up and falls back to the full
prompt. `remember[0]` on a delta pass tells the session to run `gate next
<execution-id> --full` if the send to the subagent fails, which is the
recovery path in the one place it is needed.

The `diff` nodes in `dev`, `dev-quick` and `dev-auto` run `git diff --stat
{{outputs.base.stdout}}`. The empty-diff edge is unaffected: `--stat` of no
change is still the empty string.

## Consequences

A second pass costs a fraction of a first. The saving grows with the size
of the plan and the diff, which is to say it is largest on the runs that
cost the most.

A subagent that has lost its context and is continued with a delta will
answer badly rather than obviously failing — there is no way to ask it
whether it remembers. `--full` is the recovery, and it is named in the
instruction that does the send.

The reviewer no longer receives the change as text. A reviewer agent
written by a team that does not run `git diff` itself will see only the
stat; the shipped ones are told to run it, and `dev-quick`'s already did.

A node whose inputs are unchanged between passes gets the full prompt — the
delta would be empty, and an empty delta is not an instruction.

## Touches

- `src/client/step.ts`
- `src/client/cli.ts`
- `src/workflows/defaults.ts`
- `tests/session-worker.test.ts`
- `tests/defaults.test.ts`
- `docs/design/dev-workflow.md`

## Supersedes

none. It builds on 0028, which is unchanged: the agent id is still how a
continued pass finds its subagent, and this decides what is sent once it
has.
