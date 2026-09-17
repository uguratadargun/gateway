Status: done
Branch: main
Decisions: docs/decisions/0018-unfinished-work-is-taught-as-in-progress.md
Design: docs/design/memory.md ("Teaching work from before", outcomes), docs/design/cross-team.md ("Objecting", key files)

# Unfinished work can be taught, and somebody can see what is waiting on them

## Goal

Two gaps found while walking the cross-team flow end to end with a real case: a
post-quantum service seventy percent done, whose author wants the other teams
reading it now and objecting early.

**The record overstated it.** Every taught branch was recorded `shipped` — the
word this vocabulary reserves for work that reached users, and the one its own
comment says a sibling planner reads as "settled, build on it". Teaching a
part-done branch told every other team the opposite of what was meant.

**Nobody learned of an objection.** `liveIssues` had exactly two callers, both
inside recall. An objection reached a person only if their team happened to
plan in the same paths, or somebody opened the task page of a task they
probably did not open. A team that did not touch those files for a month never
found out.

Out of scope: a count badge in the sidebar (see Assumptions), notifications of
any kind, and any check that an `in-progress` decision is kept up to date.

## Approach

`in-progress` joins the outcome vocabulary rather than reusing a word that
nearly fits, for the reason `pr-open` was split from `shipped`: these words are
read by a model planning somebody's next change. It is the person's claim, sent
as `--wip` and stored on the taught run's input, so re-teaching a landed branch
drops the claim with it. The recall brief carries a line under such a decision,
not just the label, because it changes what the reader should do.

The Objections page is the same rows recall already returns, found by team
instead of by path: `liveIssues` with no path and no feature is everything live
in the family, split into against / raised / elsewhere. Against comes first —
it is the list with something owed on it. The held-answer count sits at the top
because an answer that never reached the server is the worst failure this
feature has, and until now only the planner was told.

The settle buttons written for the task page moved into `ObjectionCard` and
both pages use it, so which side may do what is drawn in one place and matches
the endpoint.

## Assumptions

- Nobody polls. A person opens the page; the record does not chase them. A
  sidebar badge was considered and left out: the sidebar has no team scope of
  its own, so the count would go stale the moment someone switched teams on a
  page, and a stale count is worse than none.
- An `in-progress` decision that has since landed reads as less certain than it
  is. That is the safe direction, and re-teaching is one command.
- `elsewhere` is worth showing and not actionable: a parent team watching two
  of its teams disagree is the case it serves.

## Baseline

`npm test` — 710 passing, 1 skipped, green. `npm run typecheck` clean.

## Documentation

`docs/decisions/0018`. `docs/design/memory.md` gains `in-progress` in the
outcome list and `--wip` under teaching; `docs/design/cross-team.md` gains the
Objections page and its key files. Two changelog lines under Unreleased.

## What was built

1. `src/memory/types.ts`, `extract.ts`, `teach.ts` — the outcome, the flag on
   the taught run's input, `outcomeOf` reading it.
2. `src/memory/cards.ts`, `consolidate.ts` — the planner's warning line, and
   the consolidator told what the word means.
3. `src/lib/client-api-schemas.ts`, `src/client/cli.ts`,
   `plugins/gate/commands/teach.md` — `--wip` end to end, and `/gate:teach`
   asking whether the branch is finished.
4. `src/app/api/issues/route.ts` — `GET` returning the three lists and the held
   count, beside the `PATCH` that closes one.
5. `src/app/objections/page.tsx`, `src/components/objection-card.tsx`,
   `src/components/sidebar.tsx` — the page, the shared card, the nav entry;
   `src/app/tasks/page.tsx` now uses the same card.
6. `tests/memory-extract.test.ts`, `tests/memory-teach.test.ts` — the outcome,
   that it is not a shipped outcome, the warning reaching another team's brief,
   and the flag dropping when the finished branch is taught again.
   `tests/cross-team-issues.test.ts` — the board's three lists from three
   teams' points of view, and a settled objection leaving it.

## Done when

- A branch taught as unfinished never reads as shipped to another team, and
  says in the brief that objecting now is the point.
- A person can open one page and see everything unsettled for their team,
  including objections no task ever named.
- Both pages offer the same closings, to the same side, as the endpoint allows.
- The suite and the typecheck are green.
