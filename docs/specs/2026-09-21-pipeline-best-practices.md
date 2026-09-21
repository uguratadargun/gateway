Status: done
Branch: gate/pipeline-best-practices
Decisions: docs/decisions/0030-an-optional-field-may-be-written-as-null.md,
docs/decisions/0031-a-prompt-carries-what-is-new-not-what-was-already-read.md,
docs/decisions/0032-the-autonomous-road-can-stop-at-the-commit.md
Design: docs/design/dev-workflow.md (the `--stat` diff, the `delivery` gate
and the `committed` terminal, the delta a continued pass is sent and
`--full`, the node count `dev-auto` differs by), docs/design/agents-and-skills.md
(what a `?` field accepts)

# What the second dev-auto run showed, and what was fixed

## Goal

A `dev-auto` run was started on the traffic page — tabs, filters,
traceability — and watched end to end for delays, waste and anything the
pipeline had wrong about itself. The run finished and its branch is good;
this is the work on gate itself that came out of watching it.

The brief was: fix everything, turn what is wrong into what the repository
would call best practice, then run again and check the faults are closed.
Nothing was to be asked — the person was away from the machine — and no
merge request was to be opened, because they push themselves.

## What was found

**1. A finished answer thrown away for a spelling.** The verifier ended
its node with `{"verified": true, "gaps": null}` and `gate step` refused
the file: `gaps: string?` was built as zod's `.optional()`, which accepts
the key being absent and rejects `null`. The work survived only because a
person's session was driving and rewrote the file. No test anywhere had
ever put a `null` against a `?` field, and four separate places tell a
model that `?` means optional without saying what to write when there is
nothing to write.

**2. A continued subagent sent its whole brief again.** Decision 0028
keeps the subagent's id so that a second pass continues the same
conversation. The prompt sent into that conversation was still built from
scratch — the agent's whole body with every input rendered in. The
implementer's second pass was sent the task, the plan, the plan file path
and the review that sent it back, of which one was new. It is expensive,
and worse, it reads as an instruction to start the node over.

**3. The reviewer was handed the diff as text.** `git diff <base>` piped
through a node's output into the prompt of an agent that is a Claude Code
sitting in the worktree with `git` available.

**4. "Do not open a PR" had no way to be said.** The only way to honour it
was to remove the git remote so that `merge-request` would fail. The run
ended `failed`, on a terminal saying the branch was never pushed, with a
planned, built, verified and approved commit sitting on it.

**5. `not-shipped` described the wrong thing.** The same terminal is where
a genuine push failure lands, and its label implied the whole run came to
nothing when everything up to the delivery was intact.

**6. The run command told every node to ask the user.**
`plugins/gate/commands/run.md` says "Ask the user when you need to" without
qualification. The `decide` agent exists precisely so that the autonomous
road does not ask, and its own prompt had grown a defensive sentence
arguing with the command file — two documents contradicting each other in
front of the model.

**7. A test that failed on a clean branch.** `session-start-shim.test.ts`
compared `statSync(shim).mtimeMs` to `old.getTime()`; APFS keeps
nanoseconds and returns `…730.999` where the test wrote `…731`. Confirmed
pre-existing by stashing the branch and re-running.

One finding was retracted. The task text is copied into all four agents'
prompts, which looks like duplication and is not: each agent needs the
brief, and the real duplication was the resume, which is finding 2.

## What was done

- `buildOutputSchema` wraps an optional field in `nullish().transform(v =>
  v ?? undefined)`: `null`, `undefined` and absent are one answer, and a
  required field still refuses `null`. The six places the notation is
  explained now say so in the same words. Two tests hold it.
- `gate next` builds a delta for a continued pass: the node's inputs as
  they stood at its previous visit, reconstructed by folding the recorded
  steps, compared against the inputs now, and only the paths that differ
  are sent — under a preface saying which pass this is and not to start
  over. `gate next <id> --full` is the way back to the whole prompt when
  the subagent is gone. A test asserts the second prompt carries what is
  new, does not carry the first brief, is shorter, still names its own
  output file, and that `--full` brings the brief back.
- All three `diff` nodes take `--stat`. The empty-diff edge is unaffected;
  the reviewer runs its own `git diff`.
- `dev-auto` gained a `delivery` condition on the run input `deliver` and
  a `committed` terminal with status `completed`. `deliver` is read only
  by a guard, so it never becomes a required input and every existing
  `gate begin dev-auto` call is unchanged.
- `not-shipped` in all three pipelines now says reviewed and committed on
  the branch, the push or the merge request failed.
- `run.md` now says to ask when the node is one that asks, that which
  nodes those are is not the session's judgement, and that `remember`
  says which kind this one is. The `decide` agent's defensive sentence was
  removed rather than sharpened.
- The shim test rounds the mtime, with a comment saying what is under test.

## What counted as done

`npx tsc --noEmit` clean and `npm test` green — 774 passed, 1 skipped,
across 82 files — with the new behaviour held by tests that fail when it
is reverted, the record true in the present tense, and the changed
definitions pushed to the live gate so the next run uses them.

## Note on the decision numbers

These records are 0030–0032 on this branch, which is the next free number
here. The unmerged branch `gate/run-3115ea44` also carries a 0030. Whichever
lands second renumbers; `npm run docs:check` catches it as "number 0030 is
already taken" rather than letting it through.
