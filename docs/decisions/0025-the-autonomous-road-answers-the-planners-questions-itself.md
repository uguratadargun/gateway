# 0025. The autonomous road answers the planner's questions itself

Status: accepted
Date: 2026-09-20
Run: manual

## Context

`dev` turns to the person three times: `clarify` carries the planner's
questions to them, `plan-review` shows them the plan, `acceptance` puts the
finished branch in front of them before a merge request is opened. Each is
a place a run stands still until somebody answers, and a run started at the
end of the day is a branch found waiting in the morning at the first of
them. There was no shipped road for work meant to finish on its own.

The obstacle to one was the planner. Its prompt says that a decision made
on the person's behalf is a defect, because the pipeline has a way to ask
them; it stops at a question, and it plans only once the answers come back
under `clarify.answers`. A road with no `clarify` node and a planner that
asks is a road that never plans.

## Decision

`dev-auto` is `dev`'s graph with the three gates removed, and its `clarify`
node is a new shipped agent, `decide`, in place of the one that asks. The
node keeps the id `clarify`, because that is the name the planner reads its
answers under. `decide` rules on every question from the planner's own
recommendation, the repository's record and the team's memory, never asks
anyone, and ends its answers with a sentence telling the planner they were
the run's decisions, to be written into the plan's assumptions. There is no
plan review and no acceptance; `commit` continues to `merge-request`, and
the reviewer's approval is what opens it.

Two things the road does not decide. A planner still asking after three
rounds of answers ends the run on `never-planned`. A planner that objects to
another team's decision ends it on `objection-needs-a-person`.

## Rationale

The planner is kept as it is. Its rule is what makes `dev` safe, and the
alternative — a second planner told not to ask — is the copy the design
command tells every team never to make: two prompts to keep in step, and
the one that skips the rule is the one that quietly decides things nobody
sees. Answering the questions instead of suppressing them keeps every ruling
visible: the planner files them under `## Assumptions`, the spec carries the
plan, and the merge request is where the person reads what was decided for
them and undoes what they disagree with.

The node is named after what the planner reads, not after the agent in it,
for the same reason `dev-quick` names its node `implementer` while the agent
is `quick-implementer`: outputs are keyed by node id, and the shipped agents
read each other by node id.

`decide` takes the planner's recommendation unless it can point at something
that says otherwise. The planner has read the code; the answerer's job is
not to re-plan but to rule the way a careful colleague would when handed a
question with a recommended answer, and to prefer the smallest reading that
keeps existing behaviour when there is no recommendation. A question
answered with "either" costs a whole pass of the planner and settles
nothing, so the prompt forbids it.

Three rounds is the give-up because a task that is still open after three
rulings was not settled enough to hand over, and a fourth ruling is not the
one that settles it. The objection stops the run because an objection is a
request to another team: the shipped `conflict-review` already refuses to
raise one on the person's behalf when unattended, and a road with no person
has the same reason.

The road is never picked for the person. The run command lists it among the
shipped pipelines so a task with no workflow named does not land on it as
"the team's own pipeline", and starts it only by name.

## Alternatives

A planner told not to ask, in a `auto-planner` agent. A second planner is
the copy the design command forbids, and it hides the decisions in the plan
instead of marking them as the run's.

Route the planner's questions back to the planner with nothing answered.
The planner reads no answers as a first pass and asks again; the loop never
plans.

Reuse the unattended `clarify`: it answers "Nobody was there to answer.
Decide these yourself and record each decision in the plan as an
assumption", and the planner rules. In a session-driven run `clarify` is
the session's own turn and it asks the person, so the road would be
autonomous headlessly and not in a session — which is where it is run
from. And a ruling made by the planner in the same pass as its plan is one
reading; a separate node that reads the record and memory for each question
is a second, and its output is a step of its own on the execution page.

Feed the planner a literal "nobody is here" answer through the node's
`inputs` override. The override is a list of which outputs to read, not
values; there is nothing to hand it a constant with, and inventing one for
this would be a feature of the engine built for one prompt's phrasing.

Keep `acceptance` and let it hold. That is `dev` unattended, which already
exists: the branch is committed and unpushed, and the merge request waits.
The point of this road is that it does not.

Raise the objection anyway, or reject it on the run's word. Raising sends a
revision request to another team on nobody's confirmation; rejecting records
that the person was asked and said no, which is false. Stopping is the only
answer that is true.

## How it works

The graph is `dev`'s from `base` to `planner`, then: `conflict-check` sends
an objection to the `objection-needs-a-person` terminal; `plan-check` sends
questions to `clarify` unless `clarify` has already run three times, in
which case to `never-planned`, and otherwise straight to `implementer`;
`clarify` is the `decide` agent and returns to `planner`. From `implementer`
on the nodes are `dev`'s — verifier, record, stage, diff, reviewer, verdict,
stage-all, staged, commit, merge-request — with `staged` and `commit`
continuing to `merge-request` rather than to `acceptance`.

`decide` is `executor: gate` with read tools and `memory_search`, no
`asks`, so the run never shows as paused on it. It reads
`planner.questions`, the planner's notes and the recall brief. Its answers
end with the sentence the planner is told to act on, and the planner,
reading them as it reads any answers, does not re-ask what they settle.

## Consequences

Every decision the run makes is in the plan's assumptions and, through the
spec, in the merge request. A person reviewing that merge request is
reviewing those decisions as much as the code.

The reviewer is the last judgement on this road. What it approves is
pushed. A team that wants a second reviewer before an unattended push adds
one the way the engine's design doc describes, a parallel node joining at
`verdict`.

A question the planner asks in its second pass — after the first rulings —
costs another planner pass; the give-up bounds it at three rounds.

The run command lists `dev-auto` among the shipped roads, so it is never
picked on the person's behalf. `npm run defaults:restore` on a live gate
writes the new agent and workflow, since both are missing rather than stale.

## Touches

- `src/agents/defaults.ts`
- `src/workflows/defaults.ts`
- `tests/defaults.test.ts`
- `plugins/gate/commands/run.md`
- `plugins/gate/commands/design.md`
- `plugins/gate/reference/authoring.md`
- `docs/design/dev-workflow.md`
- workflows

## Supersedes

none
