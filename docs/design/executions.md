# Executions

## Summary

An execution is one run of a workflow: where it ran, the exact path it took
through the graph, what every step was handed and answered, and the branch
it left behind. Every run is driven from a person's own Claude Code session
on their own machine; the gate keeps its record. The person watches it on
the dashboard while it runs, replays it afterwards, stops it when it should
not go on, and picks a failed one back up where it left off. A run keeps its
record whether it finished, failed, was stopped, or lost the machine it was
running on.

## How it works

### Starting one

A run is started with `/gate:run <workflow> <task>` in a Claude Code
session, never from the dashboard. The workflow's page says so, with a
**Run it** card holding the line to paste (`/gate:run <id> <task>`). The
session's CLI registers the run over the client API on the person's key
(`origin: local`, `driver: session`) and reports its steps as it goes; see
`dev-workflow.md` for how a session drives it. The server takes runs only
as those reports, on `/api/v1/executions/…`. Rows an older, headless client
drove (`driver: engine`) and rows the server once ran itself (`origin:
server`) stay in the same table and are shown the same way.

### Watching it

During a run the page follows `/api/executions/<id>/stream` (SSE) and
highlights nodes as the client reports them starting and ending, and as the
run pauses for the person and resumes. The events go through an in-process
bus — gate is one process, so there is no broker — that keeps a replay
buffer per execution (the last five hundred events, held ten minutes after
the run finishes), so a page opened mid-run or just after one ends still
renders the path taken. A run reopened with `gate continue` is going again:
the end it reached is taken out of the buffer, so a page opened on it keeps
its stream open instead of replaying the old end and closing. A cockpit that
follows all of a person's runs on one connection uses
`/api/v1/executions/stream`: a snapshot of their unfinished runs first, then
every event of every run they own as it happens, never a teammate's — a key
with no person behind it sees only the runs that have no owner. The key is
asked again on every fifteen-second heartbeat, so revoking it, disabling its
person or moving them to another team ends the stream within a beat.

### The history

`/executions` lists every run; `/executions/<id>` replays the exact path a
run took — every step's input and output, its duration, and the tool calls
and usage of the steps that reported them — and links the branch it
produced. The run's diff is uploaded by the client once, when the run ends,
taken against the base commit the run started from, so it matches what the
reviewer was given. Every step of a report is written in one transaction
with whatever it implies — an objection an agent raised, a person's answer
to one — so a step is whole or absent, and a client whose report failed
re-sends the batch without making a second step.

### Stopping it

**Stop** on the execution page, or `gate cancel <execution-id>`. A run a
session drives has no process to reach — between two `gate` calls it exists
only as rows and a marker on the person's disk, and the session may have
been closed hours ago — so Stop settles it on the spot as `failed` with
`RUN_CANCELLED`. A finish report that was already on its way does not
overwrite it: a run is closed only while it is still going, and the report
is answered `alreadyFinished`, keeping the diff it brought. The session finds
out on its next `gate` call, commits
what the run left uncommitted onto its branch, and removes the worktree:
half-done work is still work, and the branch keeps it. A row an older
headless client drove gets a cancel flag instead, which that client read on
its next report.

### Runs with no process behind them

A run on someone's machine outlives the server, so a restart does not touch
it; what can be said about it is that silence means the machine went away.
A session reports when a node begins and ends, and a node can legitimately
take an hour, so a session-driven run is written off as `RUN_ABANDONED`
after six hours without a report (a row an older headless client drove,
which heartbeated between steps, after fifteen minutes). A report is counted
before anything else is read, so the report that ends a six-hour node is the
run being heard from, never the moment it is written off. A run that is
waiting on the person is never swept: the wait is theirs, it can be days,
and Stop is there for a run they have given up on. A row the server itself
was running is settled at boot as `RUN_INTERRUPTED`.

Deleting a run from the history is not a way to stop it: that removes the
record, not the work. What the run taught the team's memory stays — a
decision outlives the transcript it was read from.

### Paused

The shipped `clarify`, `plan-review` and `acceptance` nodes ask the person.
While one of them is in a session's hands the run is still `running` but
shows as **paused**: `run.paused` is emitted, its clock stands still, and the
time waited is added up separately so the run's duration is the run's. The
answer sets it going again with `run.resumed`. A run that ends while paused
— stopped, or its session gone — closes that wait first, so the clock is
right afterwards. The wait starts on the client's clock and may end on the
server's; a client running ahead is read as no wait, never a negative one.

### Picking a run back up

A run is continued on the machine it ran on, because its worktree and its
pinned definitions are on that disk. The execution page shows the command
instead of a button, with the host the run worked on: `gate continue
<execution-id>` for a failed session-driven run, and `/gate:run <workflow>`
to start any other one again. `gate continue` reopens the same execution:
the failed steps at the end of its history are dropped, the run is
`running` again, the worktree is checked out again from the run's branch at
the same path, and the next `gate next` hands out the node that failed, with
everything before it kept. Its row in the memory ledger goes too: the run is
not finished any more, the recorder never takes a run that is going, and its
real end queues it again, so what memory keeps is what the run finally did.
It refuses, with a plain reason, for a run that is still going (where `gate
next` picks it up), one that completed, one a session did not drive, one
whose worktree cannot be brought back from its branch, and one with no node
to try again — a run that ended on its workflow's own give-up terminal, or
failed before its first node. A stopped or written-off run is continued
from the node it had in hand. A row that records the run it was resumed
from links it, and its history is the whole lineage, oldest first.

### What a run cost

A node the session does itself, or hands to its subagent, is the person's
own Claude Code on their own login. It is recorded with `costing: "session"`
and no usage, and nothing on the gate sees what it cost; that is on the
person's own plan, where Claude Code's `/usage` shows it. The execution's
usage card sums only what steps reported — tokens and API-equivalent cost —
which is what runs recorded with a figure carry; a run whose steps reported
nothing shows no card.

### What went wrong, in the lines that say so

A step that refuses says so where it happened: the failing lines are lifted
out of its output and shown under it in the step list, and again at the top
of a failed run as what ended it — which node refused, with what, and how
many of its attempts it refused. The extraction drops terminal colour codes,
update banners and stack frames, and keeps assertions, type errors and FAIL
lines; when nothing matches a known failure shape, the tail of the output is
shown, since that is where runners print their summary. A gate that refused
every attempt is called out as having been red before the run started. Step
output is stripped of colour codes, because a failing suite is what you open
the step to read.

## Key files

- `src/executions/store.ts` — the execution and step tables; pausing, stopping and reopening a session-driven run, the boot-time and silence sweeps
- `src/executions/record.ts` — writing a report's steps and their consequences in one transaction
- `src/executions/quota.ts` — the usage arithmetic, pure, rendered in the browser
- `src/executions/quota-summary.ts` — summing a run's reported usage off the database
- `src/executions/failure.ts` — the lines that say why a step refused
- `src/executions/types.ts` — the shapes: origin, driver, paused state, publication, step usage and its source
- `src/events/bus.ts` — the in-process bus with its per-execution replay buffer
- `src/events/types.ts` — the event union the UI animates from
- `src/app/api/executions/` — list, read, cancel, stream and diff for the dashboard
- `src/app/api/v1/executions/` — the client API: register, report, finish, cancel, continue, and the person's own stream
- `src/app/executions/[id]/page.tsx` — the run's page: Stop, and the command that continues or restarts it on its machine

## Pitfalls

- A run cannot be started, restarted or continued from the dashboard; the page shows the command to type on the machine the run worked on.
- Stop settles a session-driven run at once, but the worktree goes only when that session next calls `gate`; until then it is still on the person's disk.
- Deleting a run deletes its ledger row for memory but not its decisions; forgetting what it taught is a separate act on `/memory`.
- A node done by the session or its subagent reports no usage; the usage card is not what the run cost.
- The replay buffer is in memory and lasts ten minutes after a run ends; a stream opened later has the database, not the events.

## Decisions

- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0046 — Every person runs on their own Claude login; gate holds no model credentials and serves no models](../decisions/0046-every-person-runs-on-their-own-claude-login.md)
- [0009 — A run is judged by the definitions it started with](../decisions/0009-a-run-is-judged-by-the-definitions-it-started-with.md)
