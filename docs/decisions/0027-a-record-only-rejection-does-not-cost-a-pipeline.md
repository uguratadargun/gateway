# 0027. A rejection that is only about the record does not cost a pipeline

Status: accepted
Date: 2026-09-21

## Context

A `dev-auto` run on 2026-09-21 spent three hours and thirty-one minutes and
ended `failed`. Every code defect it had been sent back for was fixed and
verified. What it died on was three sentences in a design document.

The review loop has one shape for every rejection. The reviewer rejects, the
verdict node sends the work to the implementer or the planner, and the whole
lap runs again: implement, verify, check the spec, stage, diff, review. A lap
is about fifty minutes on this repository and it does not get shorter when the
finding is smaller. Measured on that run: the implementer's fourth pass took
1783 seconds and 229 tool calls to carry a handful of documentation edits,
because a pass is a fresh process that reads the worktree before it can write
a word, and the verifier that followed it ran the whole suite again on a change
that had touched no source.

Four such laps hit `visits.reviewer >= 4` and the run ended on `review-stuck`,
with a branch whose code was correct and whose documents were not.

This repository asks every change to keep its record true — the design doc, the
decision, the spec, the changelog — so a reviewer that rejects on the record is
doing its job. It is the loop that answers it that is wrong.

## Decision

A review whose findings are **all** about the record takes a short way back:
one agent that may write documents and nothing else, then straight to the diff
and the reviewer again. No implementer, no verifier, no planner.

The reviewer says when that edge is taken, in a required `recordOnly` field.
A `record-fix` agent takes it, bounded to two passes; a record still wrong
after two ends on `record-wrong`, a failed terminal of its own.

## Rationale

The reviewer is the only thing in the graph that knows whether its findings
need source. It has just read the diff, the plan, the verifier's evidence and
the record; the engine reads a boolean and routes on it, which is the division
this repository already uses for `replan` and for the acceptance node's
`replan`.

`record-fix` is a named agent rather than a second entry into the implementer
for two reasons, both measured. The implementer is opus with a 5,400,000 ms
timeout, sized for building a change, where this is sonnet and fifteen minutes.
And outputs are keyed by node id: an implementer reached on this edge would
overwrite `outputs.implementer.summary`, which the commit node uses as the
commit body, so a run that took the record edge last would commit a change
under a summary describing a paragraph rewrite.

It is not a command node either. Which sentence is wrong, and what the true one
is, is a judgement — the same judgement the reviewer made, carried out.

`recordOnly` is required rather than optional because `replan` beside it is,
and a reviewer that answers one and not the other is a reviewer that is not
answering. A team whose reviewer agent predates this still works: the field is
simply absent from its output, and `src/workflows/condition.ts` evaluates an
absent key compared against `true` as false, so both record edges fall through
to the edges that shipped before them.

## Alternatives

**Let the reviewer approve and leave the documents wrong.** Rejected: the
record is the thing this repository is most consistent about, and a reviewer
told to wave through the one kind of finding it can most reliably make is a
reviewer told to lie.

**A cheaper implementer pass, told to only touch documents.** That is
`record-fix` with the wrong name, the wrong model, the wrong timeout and a
collision on `outputs.implementer.summary`.

**Loosen the give-up edge instead — six reviews rather than four.** That buys
the same run at 50 minutes a lap. The cost is the lap, not the count.

**`super-record-fix`, for symmetry with the other four.** Rejected on
CLAUDE.md's rule: shipped agents are named, never copied. What the superpowers
method changes is how a change is planned, built and reviewed, not how a
paragraph is rewritten. `dev-super` reaches this one by name, which is why the
derivation's regex leaves it alone.

## How it works

The reviewer sorts its findings into four severities — Critical, Important,
Record, Minor — and sets `recordOnly` true when every finding it is sending the
change back for is a Record finding. `dev`'s `verdict` node then reads:

```yaml
- when: outputs.reviewer.verdict == "approved"                         → stage-all
- when: outputs.reviewer.recordOnly == true && visits.record-fix >= 2  → record-wrong
- when: outputs.reviewer.recordOnly == true                            → record-fix
- when: visits.record-fix == 0 && visits.reviewer >= 4                 → review-stuck
- when: visits.record-fix == 1 && visits.reviewer >= 5                 → review-stuck
- when: visits.reviewer >= 6                                           → review-stuck
- when: outputs.reviewer.replan == false                               → implementer
- (fallback)                                                           → planner
```

`record-fix` runs and goes to `stage`, not to `record`: the spec exists by this
point, and `record`'s own give-up edge would send the round to the implementer.

The give-up edge is written three times because it now means
`visits.reviewer - visits.record-fix >= 4` and the condition language has no
arithmetic. This is the part that is easy to get wrong, and was: a visit is
counted when a node runs, **before** its edges are read
(`src/runtime/engine.ts:196`), so declaring the record edges above the give-up
edge decides which edge wins but does not stop the counter. Without the
subtraction, two record rounds would leave a change two real rejections — worse
than not having the record round at all. `record-fix` is bounded at two by the
edge above it, so three forms cover every case.

`dev-super` gets all of it by derivation. `dev-auto` carries it written out,
where it matters more than anywhere: on a road with nobody to ask, a
documentation sentence the reviewer will not accept has no other way out of
the loop.

## Consequences

A run whose code is accepted and whose documents are not now costs one sonnet
pass of a few minutes instead of a fifty-minute lap, twice, and then says so on
a terminal that names what is stuck.

A reviewer definition a team has customised must add `recordOnly` to its
schema to take the edge; until it does, it keeps exactly the pipeline it had.
`/gate:design` tells a project's own reviewer to answer it.

The `record-wrong` terminal is `failed`, not `completed`: nothing was shipped.
But a person reading it knows the code was accepted, which `review-stuck` does
not tell them.

## Touches

- `src/agents/defaults.ts` — `RECORD_FIX`, `REVIEWER`, `SUPER_REVIEWER`
- `src/workflows/defaults.ts` — `DEV`'s `verdict`, `record-fix`, `record-wrong`; `DEV_AUTO`
- `tests/defaults.test.ts`
- `docs/design/dev-workflow.md`
- `plugins/gate/commands/design.md`

## Supersedes

none. It adds an edge to the review loop recorded in `docs/design/dev-workflow.md`
and changes nothing that was decided before it.
