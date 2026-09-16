# Executions

## Summary

An execution is one run of a workflow: where it started, the exact path it
took through the graph, what every step read, wrote, ran and answered, what
it cost, and the branch it left behind. The person watches it live while it
runs, replays it afterwards, stops it when it should not go on, and picks a
stopped one back up where it left off. A run keeps its record whether it
finished, failed, was stopped, or lost the machine it was running on.

## How it works

### Starting one

`/workflows/<id>` draws the graph and takes a JSON run input (the shipped
pipelines expect `{"task": "…"}`). The same can be done over HTTP with the
admin cookie:

```bash
curl -s -c /tmp/gate.jar -H 'content-type: application/json' \
  -d "{\"secret\":\"$GATE_ADMIN_SECRET\"}" http://127.0.0.1:4141/api/admin/login
curl -s -b /tmp/gate.jar -H 'content-type: application/json' \
  -d '{"workflowId":"dev","input":{"task":"…"}}' \
  http://127.0.0.1:4141/api/executions
```

A run started this way has its engine in the server process (`origin:
server`). A run started from a developer's machine (`origin: local`) is
registered over the client API on the person's key and reports its steps as
it goes; it is driven either by the `gate run` engine (`driver: engine`) or
by a Claude Code session one node at a time (`driver: session`). All three
land in the same table and are shown the same way; see `dev-workflow.md` for
how a run on a developer's machine is driven.

### Watching it

During a run the page follows `/api/executions/<id>/stream` (SSE) and
highlights nodes and edges as they fire, with a live tool-activity feed. The
events are `workflow.started`, `node.started`, `node.output`,
`node.completed`, `node.failed`, `tool.called`, `edge.selected`,
`run.paused`, `run.resumed`, `workflow.completed` and `workflow.failed`. They
go through an in-process bus — gate is one process, so there is no broker —
that keeps a replay buffer per execution (the last five hundred events, held
ten minutes after the run finishes), so a page opened mid-run or just after
one ends still renders the path taken. A cockpit that follows all of a
person's runs on one connection uses `/api/v1/executions/stream`: a
snapshot of their unfinished runs first, then every event of every run they
own as it happens, never a teammate's.

### The history

`/executions` lists every run; `/executions/<id>` replays the exact path a
run took — every step's input, output, tool calls, model, tokens and
duration — and links the branch it produced. The run's diff is read from its
worktree while there is one and from its branch after, against the base
commit the run started from, so it matches what the reviewer was given. A
run on a developer's machine uploads its diff once, when it ends. Every step
of a report is written in one transaction with whatever it implies — an
objection an agent raised, a person's answer to one — so a step is whole or
absent, and a client whose report failed re-sends the batch without making a
second step.

### Stopping it

**Stop** on the execution page, or `gate cancel <execution-id>`. The engine
checks for it before every node and inside an agent's tool loop, so a stop
does not wait out a step that is making a dozen tool calls; the upstream
model request is really aborted, and a running command node's child process
is killed rather than abandoned. The run settles as `failed` with
`RUN_CANCELLED`, and its half-done work is committed onto its branch before
the worktree goes — half-done work is still work, and the execution page's
diff still shows it.

The server cannot reach into a process on someone's laptop, so for a run
`gate run` drives, Stop records the request and the answer rides back on the
run's next report, within a few seconds, where it aborts the run exactly as
a local Ctrl-C would. A run a session drives has no process to ask — between
two `gate` calls it exists only as rows, and the session may have been closed
hours ago — so Stop settles it on the spot; the session finds out on its
next `gate` call, and a worker still mid-node aborts on its next report.

### Runs with no process behind them

Nothing survives a restart of the server, so any run it left at `running`
is settled at boot as `RUN_INTERRUPTED` instead of sitting there claiming to
be alive. Only runs older than the process are swept, so a run that has
just started is never mistaken for an abandoned one. Runs on other machines
outlive the server and are not swept at boot; what can be said about them
is that silence means the machine went away. A run `gate run` drives
heartbeats between steps and is written off as `RUN_ABANDONED` after fifteen
minutes without a report; a run a session drives reports only when a node
begins and ends, and a node can legitimately take an hour, so it gets six
hours. A run that is waiting on the person is never swept: the wait is
theirs, it can be days, and Stop is there for a run they have given up on.

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
right afterwards.

### Restart and Continue

A stopped run offers two ways back on the execution page, for a run that
happened here; one that happened on someone's machine is continued there,
with `gate continue <execution-id>` for a run a session drove. **Restart**
begins the workflow fresh — a new worktree from HEAD, the same input.
**Continue** picks up in the same worktree, checked out again from the run's
branch, at the node it stopped on, without redoing what already ran. Where
it resumes falls out of history alone: a step that failed is retried; a step
that finished cleanly means the run stopped between nodes, so the node after
it is re-derived with the same routing the engine itself uses, from exactly
what that step produced. Nothing branches on why the run stopped —
cancelled, hit a ceiling, an upstream hiccup, all reduce to the same two
cases. A continued run is a new execution that records which one it resumed
from, and its history is the whole lineage, oldest first.

Loop and step ceilings stay real ceilings across a Continue: the visit count
carried into the resumed run is the cumulative count across every run in
the chain, never reset. A run that hit `maxVisits` lands back on the very
node that tripped it, already at the limit, and halts again immediately — at
no cost — rather than a Continue click quietly buying the workflow another
five tries. Continue refuses outright, with a plain reason, for a run that
is still going, one that already finished at a terminal, or one whose
worktree cannot be brought back from its branch. A run that reached a
terminal never records a step for it, so what says "this was the end on
purpose" is the absence of an error: a finished run with no error is done,
and one with an error stopped somewhere still in progress.

### What a run cost

An execution shows what it used: its own tokens and API-equivalent cost,
summed from its steps, so concurrent runs and ordinary Claude Code traffic
are never in that number. A step the session did itself, or as its
subagent, arrives without usage — its model calls went through the person's
own Claude Code — so it is costed afterwards from that session's gateway
calls between the step's start and end, and marked as an attribution (a "≈"
figure), since the session may have done other things in those minutes.
Without the plugin's session hook naming the session, such steps stay
uncosted and say nothing rather than claim zero.

The run also estimates its share of the 5-hour and weekly rate-limit
windows. The API reports where a window stands, never what one request
moved it by, and reading the utilisation before and after would measure
everything else happening at the same time. So the share is attributed: at
the moment the run ends, the current utilisation is divided across the
gateway traffic inside that window, weighted by cost, and the run takes its
slice, labelled as an estimate. The windows' positions before and after the
run are kept on the row.

### What went wrong, in the lines that say so

A step that refuses says so where it happened: the failing lines are lifted
out of its output and shown under it in the step list, and again at the top
of a failed run as what ended it — which node refused, with what, and how
many of its attempts it refused. The extraction drops terminal colour codes,
update banners and stack frames, and keeps assertions, type errors and FAIL
lines; when nothing matches a known failure shape, the tail of the output is
shown, since that is where runners print their summary. A gate that refused
every attempt is called out as having been red before the run started.

When a run stops at a loop ceiling, the error names what kept sending it
back — `node "implementation" ran 6 times (max 5); last sent back by "tests"
(exit 1)` — because a loop limit on its own says a node repeated, not why,
and the step that routed there is the one that refused. Step output is
stripped of colour codes, because a failing suite is what you open the step
to read.

## Key files

- `src/executions/store.ts` — the execution and step tables; pausing, stopping, the boot-time and silence sweeps, session-usage attribution
- `src/executions/runner.ts` — wires the engine to persistence and the event bus; starting, cancelling and continuing a run on the server
- `src/executions/resume.ts` — where a stopped run picks up, read from its history alone
- `src/executions/record.ts` — writing a report's steps and their consequences in one transaction
- `src/executions/quota.ts` — the cost arithmetic, pure, rendered in the browser
- `src/executions/quota-summary.ts` — reading a run's totals and window calibration off the database
- `src/executions/failure.ts` — the lines that say why a step refused
- `src/executions/types.ts` — the shapes: origin, driver, paused state, publication, step usage and its source
- `src/events/bus.ts` — the in-process bus with its per-execution replay buffer
- `src/events/types.ts` — the event union the UI animates from
- `src/app/api/executions/` — start, read, cancel, resume, stream and diff for the dashboard
- `src/app/api/v1/executions/` — the client API: register, report, finish, cancel, continue, and the person's own stream

## Pitfalls

- A run driven by `gate run` that is stopped from the dashboard does not stop until its next report; expect a few seconds, not an instant.
- Continue does not reset ceilings. A run that stopped on `maxVisits` will halt again at once; raise the ceiling in the workflow or Restart.
- Restart and Continue are only on the page for runs the server ran; a run from a developer's machine shows the command to type there instead.
- Deleting a run deletes its ledger row for memory but not its decisions; forgetting what it taught is a separate act on `/memory`.
- The rate-limit share is an attribution, not a measurement. Two runs in the same window split the window's movement by cost, and neither figure is exact.
- A session-driven step costed as `session` includes whatever else the session did in those minutes; without the session hook the step shows no cost at all.
- The replay buffer is in memory and lasts ten minutes after a run ends; a stream opened later has the database, not the events.

## Decisions

- none recorded yet
