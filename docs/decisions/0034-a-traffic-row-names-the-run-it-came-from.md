# 0034. A traffic row names the run it came from

Status: accepted
Date: 2026-09-21

## Context

[0017](0017-the-traffic-log-names-who-called-and-who-served.md) named who
called and who served, and deliberately left one question for later: it made
"a row for every cache hit and every refusal" its own decision rather than
answering it inside a display feature. This change answers a different
question that 0017 also left open — not *how many* rows exist, but what a row
that does exist can be traced back to.

A served request today can come from a person typing into a client, or from a
workflow node — gate's own pipeline running a step, or a Claude Code spawned
on a run's token. The traffic row could name the workflow sentinel as its
caller, but nothing on the row said *which* run, which node, or let a person
go from a row on `/traffic` to the execution that produced it. A question
about one exchange — "what was this row, and can I see the rest of that
run" — had no answer in the product, only in whichever terminal the run
happened to still be open in.

The log was also a fixed 500 rows, a number chosen before the log carried
anyone's name or run, and by the time a team is a few people deep at normal
traffic it is minutes of history, not enough to find the run that trips a
budget or a rate limit hours after the fact.

## Decision

The execution id rides on the `Principal` — set once, in `withRunToken`, on
every request made on a run's token — and lands on the traffic row next to
the ids 0017 already wrote. The node is not written; it is resolved at read
time, from which of the run's recorded steps was open when the request's
timestamp falls inside that step's start/finish window. The row also gains
its own id, minted when the request is dispatched, so one exchange can be
named and found again independently of its run. The log's retention moves
from the fixed constant to a setting, `traffic.maxRows`, raised to 5,000.

## Rationale

The run token already wraps the whole run and is what a spawned Claude Code
authenticates with when it calls back into gate — it is the one place a
node's real traffic, not just gate's own in-process dispatch, is guaranteed
to pass through. Stamping the execution id there means every route to the
gateway a run can take — gate holding the conversation itself, or handing it
to a child process — carries the same field the same way, with no second
mechanism to keep in step with the first.

Resolving the node at read time rather than writing it follows the same
"ids at write time, names at read time" rule 0017 established for the caller
and the account: a step's boundaries are only known for certain once the step
row exists with a `started_at`, and for the engine-held path they are cheap
to join against by timestamp, exactly like the account and person joins
already there. Writing a node id at write time would mean something different
for the two paths that produce a traffic row — knowable immediately for one,
guessed for the other — and one column cannot mean two things.

Five thousand rows is ten times the previous ceiling and is now a setting
rather than a constant so a team can raise or lower it without a code change,
with a floor that keeps a hand-edited value from turning the log into one row
or an unbounded one.

## Alternatives

**Join through `client_session`.** The session id `/analytics` already groups
by looked like the natural key. It fails for exactly the traffic this
decision is for: a spawned Claude Code has its own session id, unrelated to
the run's, and an engine-held node sets no session at all — `client_session`
is NULL on precisely the rows a run wants to trace.

**Write the node id at request time.** Knowable for the engine-held path,
which already knows which node it is running; not knowable for a spawned
Claude Code's own gateway calls, which know only their run's token, not which
step is currently open from the engine's point of view. Writing it only
sometimes would make the column mean two different things depending on which
path produced the row.

**A time-based retention window instead of a row count.** Bounds the log by
age, not by size, which does not bound it on disk — a noisy team's window
could hold far more than a quiet team's fixed count, and disk is the resource
being managed here, not recency.

## How it works

`withRunToken` stamps `executionId` onto the principal it registers for a run's
token, so `gatePrincipal` returns it on every request made on that token
without any caller having to remember to set it. `dispatch` mints a random
16-hex-character request id at the top of the call, the same shape a key id
already has, and `finalize` writes both it and `opts.caller?.executionId`
alongside the ids 0017 added.

`readTraffic` takes a query now instead of a bare limit — person, served,
tier, request id, each optional and additive — and its `SELECT` gains a
`LEFT JOIN` to `workflow_executions` for the workflow id, plus a correlated
subquery over `workflow_execution_steps` for the node: the step whose
`[started_at, finished_at]` window contains the row's timestamp, newest
`step_index` first so two overlapping candidates resolve to the one that was
current. A row whose execution or step is gone, or was never made for one,
degrades the same way a deleted account already does — NULL, and the row
still renders. `trafficFacets()` computes the filter bar's options — every
person and every served-by ever seen — over the whole table, unaffected by
whatever is currently filtered, so an option a filter has narrowed away does
not vanish from the list that would put it back.

`traffic.maxRows` joins the other clamped settings fields, floored at 100 in
both the zod schema and `mergeSettings`, defaulting to 5,000; `recordTraffic`
prunes to whatever it currently reads rather than a compiled-in number.

## Consequences

The log is a trace now, not only a debugging log with names attached — which
is what reverses the framing in `gateway-pipeline.md`'s pitfalls: a row that
exists still under-counts callers exactly as before, but a row that exists
can now be followed back to the run and the step that made it.

Ten times as many rows of people's prompts and replies sit on disk behind the
admin cookie. The boundary has not moved — the same cookie already gated the
500-row log — but the amount of what it gates grew by an order of magnitude,
which is why the number is a setting a team sets on purpose rather than a
constant nobody chose.

`Principal.executionId` is trace data, carried for attribution and never
consulted by an authority check; a future change that reads it to decide
whether to allow a request would be reusing a field for something it was not
shaped for.

A row written before this release reads NULL for its own id, the execution
id, the workflow and the node, and still renders — the same degrade-to-honest
rule every other join on this table already followed.

## Touches

- `src/lib/apikeys.ts`
- `src/lib/run-tokens.ts`
- `src/lib/gateway-core.ts`
- `src/lib/traffic.ts`
- `src/lib/db.ts`
- `src/lib/settings.ts`
- `src/lib/schemas.ts`
- `src/app/api/traffic/route.ts`
- `src/app/api/export/route.ts`
- `src/components/traffic-log.tsx`
- `src/components/live-activity.tsx`
- `src/app/traffic/page.tsx`
- gateway-pipeline
- dashboard

## Supersedes

none. [0017](0017-the-traffic-log-names-who-called-and-who-served.md) still
holds in full: who called and who served is unchanged, and this decision adds
the run alongside it.
