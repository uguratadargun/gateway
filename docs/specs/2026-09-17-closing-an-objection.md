Status: done
Branch: main
Decisions: docs/decisions/0016-an-objection-is-closed-by-the-side-it-belongs-to.md
Design: docs/design/cross-team.md ("Objecting", pitfalls), docs/design/memory.md ("Objections between teams")

# An objection can be closed

## Goal

`resolved` and `withdrawn` were defined states with written transitions and no
caller: no endpoint, no button, no node. A confirmed objection stood forever.
The team objected to read it in every recall touching those paths, made the
change it asked for, and read it again next time; the team that raised it could
not take back one it had found wrong.

The record said two different things about this. `docs/design/memory.md`
described all four powers as working; `docs/design/cross-team.md` recorded under
its pitfalls that resolving and withdrawing had no surface. Both are now true
statements of the same thing.

Out of scope: closing from a run or the CLI, and any check that a resolution is
honest — 0016 rules out the first and accepts the second.

## Approach

One endpoint, `PATCH /api/issues`, on the admin surface where the task page
already lives. The acting team is the dashboard's scope, as on `/api/tasks`.
Which side that team is on decides what it may do: the target resolves, the
source withdraws, and an objection it is on neither side of reads as absent
rather than as refused — the same shape every other family refusal has here.

Resolving requires a note because the note has a reader: `resolved` and
`withdrawn` are outside `LIVE_ISSUE_STATUSES`, so the row leaves both teams'
recall, and the resolution is the last thing the objecting team is told. A
withdrawal takes none; there is nothing to say that its disappearance does not.

Nothing in `src/memory/issues.ts` changed. The transitions were already written
with these rules in their own comments, and the guards on status
(`proposed`/`open` only) already made a second settling a no-op — the route
turns that into a 409 rather than a silent 200.

## Assumptions

- One administrator drives the dashboard, so `resolved_by` records the acting
  team rather than a person; that is who the other team needs to know answered.
- A team switching the picker to the other side of its own family could close
  either end. That is the same trust the admin surface runs on everywhere and
  is not worth a second permission layer for one button.

## Baseline

`npm test` — 697 passing, 1 skipped, green. `npm run typecheck` clean.

## Documentation

`docs/decisions/0016`. `docs/design/cross-team.md` gains how an objection is
closed and two pitfalls replacing the one that said it could not be;
`docs/design/memory.md` names the surface it had already claimed. One changelog
line under Unreleased.

## What was built

1. `src/app/api/issues/route.ts` — `PATCH` with `resolve` and `withdraw`, the
   side check, the required note, 404 for an objection this team is on neither
   side of, 409 for one already settled.
2. `src/app/tasks/page.tsx` — Resolve and Withdraw on a live objection, shown
   by side; resolving opens an inline note field and the button stays disabled
   until it says something.
3. `tests/cross-team-issues.test.ts` — resolving and the note leaving both
   recalls, withdrawing, each side refused the other's closing, a stranger team
   getting "no such objection", an empty note refused and a second settling
   refused.

## Done when

- The team objected to can resolve, the team that raised it can withdraw, and
  neither can do the other's.
- A closed objection stops reaching either team's planner and keeps its row.
- No run, node or CLI command closes one.
- The suite and the typecheck are green.
