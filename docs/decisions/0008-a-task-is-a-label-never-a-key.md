# 0008. A task is a label, never a key

Status: accepted
Date: 2026-09-16
Run: bbf6c81

## Context

A run belongs to one team and one repository, and it ends. Desktop ships something, the server team reads it a week later and finds it will not hold, and the thing both runs were about has no name at all — so there is nowhere to ask what is still unsettled across the teams. Objections between teams (0002) attach to decisions and to the paths they touch, which answers "is this decision disputed" but not "is this piece of work finished".

## Decision

A change task is the smallest record that outlives the runs serving it: an id, an owner, a title, a status. Runs link to one, continued runs inherit it, and objections raised by a run are stamped with it. It is a label and never a key: nothing is required to have one, nothing is found only by it, and a task is closed by a person rather than by a run finishing.

## Rationale

Everything that must work has to keep working for a run started without a task. An objection raised by such a run still reaches the team it was raised against, because the paths and the feature are what carry it — the task only groups what is already routed. Making the task a key would mean a run that forgot to pass one silently loses its objections, and the failure would show up as silence.

A task spans teams and runs, so nothing may depend on it being present or accurate. It is a view: open it and see the runs filed under it and the objections still unresolved beneath them.

Closing is a person's judgement. A run finishing means one pipeline reached a terminal, which is not the same as the work being settled — the objection that matters most usually arrives after the run that caused it has ended.

The family is the boundary, as it is everywhere else. A task outside the caller's family is refused rather than stored, and refused with an answer that does not admit it exists.

`gate run --task-id` files a run under one, named so rather than `--task` because the trailing prompt already goes by that word.

## Alternatives

Make the task the unit runs belong to, with a run requiring one. Every existing run would need backfilling, every caller a new required argument, and a run started without one would have nowhere to put its objections. The value of the record is not worth making the common path fail.

Group by repository and feature instead, which memory already records. That groups work that happens to touch the same code, not work that is one change: a refactor and a feature in the same files are one group and two pieces of work.

Group by branch name. A branch belongs to one repository and one team, and this record exists precisely for work that spans both.

Close a task when its last run finishes. A run reaching a terminal is not the work being settled, and an automatic close would hide exactly the objections raised after it.

## How it works

`change_tasks` holds the id, the owning team, a title and summary, and a status of `open`, `done` or `abandoned`. A run carries an optional `task_id`; a continued run inherits its parent's. An objection raised by a run is stamped with that run's task, so a task can list what is unresolved under it without owning the objections.

Reading is family-scoped: a team sees its own tasks and its family's, on the same boundary memory uses. A task outside the family reads as absent. Status is set by a person, from the dashboard. A run may file itself under a task; it cannot open one.

The task's page leads with what is still unsettled — the open objections beneath it — rather than with the runs, because the runs are how you got here and the objections are what is left.

## Consequences

A task's view is only as complete as the runs that bothered to name it. A run started without `--task-id` does its work and raises its objections normally, and simply does not appear under the task; there is no way to tell from the task that it happened.

The record is deliberately thin. Anything that starts requiring a task — routing, permissions, recall — turns a label into a key and reverses this decision.

## Touches

- `src/orchestration/tasks.ts`
- `src/app/tasks/page.tsx`
- `src/client/cli.ts`
- orchestration
- memory

## Supersedes

none
