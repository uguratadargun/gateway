Status: done
Branch: pipeline/record-only-and-subagent-addressing
Decisions: docs/decisions/0027-a-record-only-rejection-does-not-cost-a-pipeline.md,
docs/decisions/0028-a-subagent-is-addressed-by-its-agent-id.md,
docs/decisions/0029-dev-auto-is-a-literal-kept-in-step-by-a-test.md
Design: docs/design/dev-workflow.md (the record round, the three give-up
forms, `dev-auto`, the subagent address), docs/design/agents-and-skills.md
(the three notices and the two sites that issue them)

# What made a 3h31m run end failed with three sentences left

## Goal

A `dev-auto` run on 21 September took **3 hours 31 minutes**, went four full
turns, hit the `visits.reviewer >= 4` give-up edge and ended `status: failed`
— with every code finding already fixed and verified, and three documentation
sentences outstanding. The run's own JSONL transcripts were read line by line
rather than guessed at:

| Finding | Measurement |
| --- | --- |
| Implementer pass 4 | 1783 s, 229 tool calls, 80.7% model generation — no single stall, 229 round trips at ~7.8 s |
| — cold start | 5.2 min, 34 Bash calls, all of them looking at files, before the first edit |
| — refused edits | 13, costing 142 s: "File has not been read yet" |
| — read tools | Read: 43 calls / 1.0 s. Bash: 107 calls / 224.6 s (~143 s of it zsh startup). Grep/Glob: none |
| — tests | 1.5 min, 5% — test discipline is not what is expensive |
| Verifier pass 4 | 18.3 min; the checks were green at 59 s; the remaining 85% was waiting on forks |
| — fork recursion | 4 forks became 16 dispatches; one branch's queue was 7.25 min, 40% of the node |
| — idle polling | 15 of 24 Bash calls were `true` / `sleep` / `echo` / `date` |
| Reviewer pass 3 | a 425.9 s Opus fork's output was never read; the verdict was written without it |
| Addressing | `--subagent <agentId>` resolves; `--subagent gate-desktop-implementer` (the type name) never does, and was accepted silently |
| — its cost | every pass respawned from nothing: the verifier tree read the plan 14×, `cli.ts` 11× |
| Structural | one reviewer bounce is a full turn, ≈50 min, whether the finding is a bug or a sentence |

What done looks like:

- a rejection that is only about the record does not cost a planning,
  building and verifying turn, and does not spend a review;
- a `--subagent` value that cannot be resumed is refused at the point it is
  typed, not written into the session file;
- what the harness charges for — a subagent that copies its own context, a
  file read through the shell — is told to every `claude-code` node by gate,
  not by four agent prompts that drift;
- `dev-auto`, which was hand-written on the server and so was neither
  versioned nor tested, ships from this repository.

Out of scope: deploying to the live gate. `npm run defaults:restore --
--refresh` against `http://10.0.80.35:4141` is the user's to run, and it
replaces team `desktop`'s hand-written `dev-auto.yaml` and `decide.md` with
the shipped text, backing the old up under `<team>/backups/<stamp>/`.

## Approach

Four changes, each against one of the measurements, and none of them a
ceiling:

**The record round.** The reviewer gains a required `recordOnly` field, true
only when *every* finding it is sending the change back for is about the
repository's record. `verdict` then routes to `record-fix`, a sonnet agent
that may touch `docs/`, `CHANGELOG.md`, the plugin's prose and misleading
comments and nothing else, and hands back to `stage`. Two rounds that still
do not satisfy the reviewer end on `record-wrong`. Because a visit is counted
when a node runs, before its edges are read, the record round would otherwise
eat a review; the give-up edge is therefore written as
`visits.reviewer - visits.record-fix >= 4` in the three forms the condition
language can express.

**The refusal.** Prose could not fix the addressing: the permissive sentence
was in three places and `--subagent` accepted anything. The guard sits in
`step()` before `record(...)` — after it, the node would be recorded as run
with no resume target.

**The notices.** `backgroundSubagentNotice()` is rewritten (the old "never
sleep in a shell loop" did not catch a bare `true`), and `fileReadingNotice()`
is added. Both are injected at the two sites that already issue the
unattended notice, so the invariant is unchanged — it is about the sites, not
the count.

**`dev-auto`.** Taken into `src/workflows/defaults.ts` as a literal, with
`decide` taken verbatim from the server snapshot. It cannot be derived the
way `dev-super` is: that is a pure rename, this removes six nodes and
rewrites `plan-check`. A test holds it body-for-body against `dev` instead.

## Baseline

`tests/defaults.test.ts` ran the shipped graphs end to end with stand-in
agents and pinned the agent and workflow id lists. Those tests keep passing;
the `APPROVED` fixture, which omits `recordOnly`, is deliberately left as it
is, because it is what proves a team on an older reviewer definition falls
through to today's edges.

## What was built

1. `src/skills/inject.ts` — `backgroundSubagentNotice()` rewritten,
   `fileReadingNotice()` added, the invariant comment made plural;
   `src/runtime/executors/claude-code.ts` and `src/client/subagents.ts`
   issue all three.
2. `src/client/step.ts` — `--subagent gate-<team>-…` refused before
   `record(...)`; the three prose sites corrected.
3. `src/agents/defaults.ts` — `recordOnly` on `REVIEWER` and
   `SUPER_REVIEWER` (required, like `replan`), the severity prose rewritten
   with a Record level; `RECORD_FIX`; `DECIDE`.
4. `src/workflows/defaults.ts` — `verdict`'s new edge list, `record-fix`,
   `record-wrong`, and the three give-up forms, in `DEV` and so in
   `DEV_SUPER`; `DEV_AUTO`.
5. Tests — `tests/inject.test.ts` (new), the record round and its arithmetic
   in `tests/defaults.test.ts`, the shape test for `dev-auto`, the refusal in
   `tests/session-worker.test.ts`.

## Done when

- A record-only rejection runs `record-fix` and reaches `done` without the
  implementer or the verifier running again — a test.
- Two record rounds end on `record-wrong` — a test.
- Record rounds do not spend reviews: `visits.reviewer === 6` still reaches
  `review-stuck` — a test.
- A reviewer that does not answer `recordOnly` falls through to today's edges
  — a test.
- `--subagent` with a type name throws, records no node, and leaves the
  recalled subagent as it was — a test.
- All three notices are present at both injection sites — a test.
- `dev-auto` is `dev` body-for-body except where it routes, and contains no
  `github.com` — a test.
- No shipped workflow sets an engine ceiling — a test over all of them.
- `npm test`, `npm run typecheck` and `npm run build:cli` pass.

## Follow-up

The version had already moved to 0.41.0 in the working tree, by the parallel
session that landed `0020-connecting-never-needs-a-model-turn.md`; this work
rides on the same bump rather than adding one, and `npm run changelog:release`
is that session's call. The remote gate still runs the hand-written
definitions until the refresh above is run.
