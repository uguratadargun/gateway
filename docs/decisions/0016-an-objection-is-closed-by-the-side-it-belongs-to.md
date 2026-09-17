# 0016. An objection is closed by the side it belongs to, from the dashboard

Status: accepted
Date: 2026-09-17

## Context

An objection has five states and only three of them can be reached. A run's
planner raises one as `proposed`; the person watching that run confirms it to
`open` or refuses it to `rejected`. `resolved` and `withdrawn` are defined,
their transitions are written, and nothing anywhere calls them: no endpoint, no
button, no node.

So an objection, once confirmed, stands forever. The team objected to reads it
in every recall that touches those paths, makes the change it asks for, and
reads it again the next time. The team that raised it cannot take it back after
finding it was wrong. `docs/design/memory.md` describes all four powers as
though they work, and `docs/design/cross-team.md` records under its pitfalls
that they do not — the record disagrees with itself because the code does.

## Decision

An objection is closed by the side it belongs to, and only from the dashboard.
The team whose decision was objected to may `resolve` it, with a note saying
what was done; the team that raised it may `withdraw` it. Neither may do the
other's. The acting team is the one the dashboard is scoped to, and no run,
node or CLI command closes an objection.

## Rationale

The two closings are different facts and are worth keeping apart. "We met your
request" is the objected-to team's to say; "never mind, we were wrong" is the
raiser's. One button that any side could press would record that the
disagreement ended without recording which of those happened, and the next
planner to read the row is exactly the reader who needs to know.

Closing is a judgement, not an outcome. A run finishing on the objecting side
is not evidence the other team accepted anything, and a run on the objected-to
side that touched those files is not evidence it met the request — it may have
planned around it, or said in its plan why the objection does not hold, which
the planner is explicitly allowed to do. Letting a run close the dispute it is
party to is what 0002 avoided by making the objection a record instead of a
message.

The dashboard rather than the CLI, on the same reasoning as 0010: the person
making this call is judging another team's claim about their code, which is the
kind of thing a person does while looking at it, and the task page already puts
the objection next to the runs and the work it belongs to.

A note is required to resolve and not to withdraw, because the note has a
reader. The objecting team's next recall shows the resolution; an empty one
tells them the row moved and nothing else. A withdrawal has nothing to tell the
other side that its disappearance does not.

## Alternatives

Let the verifier or a `resolve` node close it when the run that addressed the
objection ends. The engine would be routing on a model's account of somebody
else's satisfaction, and a run that worked around the objection would close it
just as surely as one that met it.

Close it automatically when the objected-to team supersedes the decision it was
raised against. Superseding is not agreeing: the new decision may restate the
old one for better reasons, and the objection would vanish on a change that
never addressed it.

One `close` action any team in the family may take. Simpler, and it loses which
of the two things happened, which is the only reason to look at a settled
objection at all.

A CLI command. The judgement is not made at a terminal, and every surface added
is one more place the family check has to be right.

## How it works

`PATCH /api/issues` takes an id and `resolve` or `withdraw`. The acting team
comes from the dashboard's scope, as everywhere else on that surface. `resolve`
is refused unless that team is the objection's target and a note is given;
`withdraw` is refused unless it is the objection's source. An objection the
acting team is on neither side of reads as absent, in the wording a missing one
gets. Only `proposed` and `open` move; a settled objection is settled.

`resolved` and `withdrawn` are outside `LIVE_ISSUE_STATUSES`, so a closed
objection leaves both teams' recall at once and stops blocking nothing. The row
stays, with its resolution, who closed it and when.

`rejected` is unchanged and is not one of these: it is the raising side's own
person refusing to send the objection at all, before the other team ever sees
it.

## Consequences

An objection can be resolved while the code still disagrees. Nothing verifies
the note, and the only record that it was settled honestly is who settled it —
which is the same trust the rest of the ledger runs on.

A withdrawal is quiet. The team that was objected to may have already planned
around it, and all they see is that it is gone; the row says what happened, and
nothing pushes that at them.

Closing every objection under a task still does not close the task, and closing
a task still settles none of them. 0008 is untouched.

## Touches

- `src/app/api/issues/route.ts`
- `src/app/tasks/page.tsx`
- `src/memory/issues.ts`
- orchestration
- memory

## Supersedes

none
