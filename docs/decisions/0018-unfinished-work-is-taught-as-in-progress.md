# 0018. Unfinished work is taught, and says it is unfinished

Status: accepted
Date: 2026-09-17

## Context

Teaching a branch recorded every decision in it as `shipped` — the word this
vocabulary reserves for work that reached users, and the one its own comment
says "a planner on a sibling team reads as settled and builds on it". That was
right while teaching meant one thing: a person asserting work that had landed.

It is not the only thing people teach. The case that broke it is a piece of
work part-way done — a post-quantum handshake at seventy percent — that its
author wants the other teams to read *now*, so they build against it and say
early if it does not fit. Taught today, every choice in it reaches those teams
labelled `shipped`, which is the opposite of what is being claimed, and the
objection that would have been cheap arrives after the design has set.

## Decision

A teaching may say the branch is not finished, and the record says so: `gate
teach --wip` records that run's decisions with the outcome `in-progress`. It is
outside `SHIPPED_OUTCOMES`, and a planner shown such a decision is told in the
recall brief that the work is still moving and to object now rather than build
on it. Teaching the same branch again without the flag, once it lands, makes it
the person's word again.

## Rationale

This vocabulary exists because the words are read by a model planning
somebody's next change, and `pr-open` was split from `shipped` for exactly this
reason: an offer to ship is not a shipment. Work in progress is weaker than
either, and there was no word for it — every existing one would have overstated
it.

Half-done work is worth putting in memory, and that is the premise worth being
explicit about. A team that waits until the work lands gets its objections at
the point they are most expensive, when the design has set and the other team
has built on it. The record exists to move that conversation earlier.

The flag is the person's claim, like `shipped` before it. Gate cannot see how
finished a branch is — a seventy-percent branch and a finished one are the same
commits to it — so the only honest source is the person teaching it, and the
outcome says whose claim it is by being on a taught run at all.

The warning in the brief is a line of its own rather than a word in a line of
labels, because it changes what the reader should do. Every other outcome
answers "how far did this get"; this one answers "should you build on it yet",
and a reader skimming the label row would not notice.

## Alternatives

Record it as `completed` — "the run finished, nothing offered it for merge".
Nothing new in the vocabulary, and the word still reads as done to anyone who
has not memorised the distinction. The whole point of the split is that the
word means what it says.

A separate command for sharing unfinished work, distinct from teaching. It
would duplicate the account, the range-reading and the recorder for one boolean
of difference, and leave two ways to put a branch in memory that drift apart.

Leave it out and let people teach only finished work. That is where this
started, and it means the record is silent about everything currently being
built — which is the part other teams most need to plan around.

## How it works

`gate teach --wip` sends `wip` with the teaching. It is stored on the taught
run's input, and `outcomeOf` returns `in-progress` for a taught run carrying it
and `shipped` for one that does not — so re-teaching a branch that has since
landed drops the flag and the claim with it. The consolidator is told what the
word means, so a feature's page does not write such a decision up as live.

`describeDecision` puts a line under an `in-progress` decision telling the
planner the work is unfinished and to raise an objection now. `/gate:teach`
asks whether the branch is finished when the user has not said, and asks the
account to name what is done, what is not, and what is most likely to move.

## Consequences

An `in-progress` decision can sit in memory long after it settled, if nobody
teaches the branch again. It reads as less certain than it is, which is the
safe direction for this to be wrong in, and re-teaching is one command.

Two teachings of the same branch may disagree about whether it is finished; the
later one wins, because that is what replacing a teaching already means.

Nothing counts or chases in-progress decisions. A team wanting to know what its
siblings are mid-way through reads the feature's page, as before.

## Touches

- `src/memory/types.ts`
- `src/memory/extract.ts`
- `src/memory/teach.ts`
- `src/memory/cards.ts`
- `plugins/gate/commands/teach.md`
- memory

## Supersedes

none
