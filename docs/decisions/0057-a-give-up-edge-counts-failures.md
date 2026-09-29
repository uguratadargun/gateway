# 0057. A give-up edge counts failures, on a node only a failure reaches

Status: accepted
Date: 2026-09-29
Run: manual

## Context

Every loop in the shipped pipelines ends on a give-up edge that lands on a terminal saying what is stuck: the engine routes, and there are no run ceilings. Those edges read visits of the node that judges — `visits.verifier >= 3`, `visits.record >= 3`, `visits.reviewer >= 4`. A visit is counted every time a node runs, so a verification that passed on an earlier lap, a record check that passed, and a review the reviewer approved and the person then sent back each spent one of the rounds. Walked through the real `dev` graph, a run with two green review laps ended on `not-verified` at the first gap of its third lap, its first record failure on lap three ended on `no-spec`, and three approved reviews the person revised followed by the first rejection ended on `review-stuck`. The same flaw had been patched once for record rounds by writing `visits.reviewer - visits.record-fix >= 4` as three edges.

## Decision

A give-up edge counts failures. The failure edge out of the node that judges goes to a small condition node that only a failure reaches, and the give-up edge counts visits to that node. The shipped pipelines use `gaps` after the verifier (three, then `not-verified`), `record-missing` after the record check (three, then `no-spec`) and `rejected` after the review verdict (four in `dev` and `dev-auto`, three in `dev-quick`, then `review-stuck`). The authoring reference teaches the same shape for any loop a team writes.

## Rationale

The labels and comments already said what was meant: failed checks, asks for the record, rejections. A node reached only on failure makes "visits" mean "failures" with the language as it is — no engine change and nothing new for the walk or the loader — and the rules hold as they were. It also retires the three-form subtraction: a record round goes to `record-fix` and never reaches `rejected`.

## Alternatives

Arithmetic in the condition language. It fixes the sums but not the reading, and it grows the language every workflow is parsed with.

A new condition root counting edges taken. It says "failures" exactly, but the walk would have to track edges and the loader validate a new root.

Counting failures per lap. Closer to "three rounds answering the same gaps", but the language cannot reset a counter.

## How it works

`dev`, `dev-auto` and `dev-quick` route verifier failures to `gaps`, record failures to `record-missing` and non-record rejections to `rejected`. Each of those condition nodes carries the give-up edge first and the loop back as its fallback. `dev-super` is derived from `dev`'s text and follows; the `dev-auto` shape test holds because the new nodes are shared with `dev`.

## Consequences

The count is per run, not per lap: three failed verifications across the whole run end it. Every failure records one extra condition step, and the graph shows one more node per loop. A live gate keeps the old pipelines until `npm run defaults:restore -- --refresh` rewrites them. A team workflow that counts visits of the judging node keeps working as it did.

## Touches

- `src/workflows/defaults.ts`
- `plugins/gate/reference/authoring.md`
- `plugins/gate/commands/design.md`
- `docs/design/dev-workflow.md`
- `docs/design/workflows-engine.md`
- dev-workflow

## Supersedes

none
