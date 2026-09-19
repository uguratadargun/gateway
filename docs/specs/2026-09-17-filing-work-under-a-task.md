Status: done
Branch: main
Decisions: none
Design: docs/design/cross-team.md ("The task ledger")

# Every way work reaches the gate can name its task

## Goal

A cross-team task grouped only what a headless `gate run --task-id` filed under
it. The two other ways work reaches the gate could not name one: `gate begin`
— the session protocol `/gate:run` drives, which is how most runs start — read
no such flag, and `gate teach` had no field for it at all.

The effect was worst in the case the record exists for. A person notices work
spans two teams, opens a task on the dashboard, and is standing on the branch
that already holds the change. Teaching that branch is the only way its
decisions reach memory, and teaching could not say what the work was for — so
the task they had just opened stayed empty for the one branch it was opened
about.

Out of scope: filing a run that has already finished. `task_id` is written when
the row is created and nothing updates it afterwards; a task opened mid-flight
still shows only what started after it.

## Approach

The flag is the same everywhere, because it is the same claim about the same
record: `--task-id`, checked with `taskVisibleTo` against the caller's family
before anything is stored, refused as `no such task` / `TASK_NOT_FOUND` in one
wording. A caller cannot learn from a refusal that another family's task
exists.

`begin` takes it as an option and passes it to `startRun`, which already
carried the field — the server side needed nothing. Teaching gains a `taskId`
on its schema, a family check on its route, and the id on the execution it
creates.

Teaching the same branch twice takes the task the earlier teaching did not
name, `task_id = COALESCE(?, task_id)`, on the precedent `repo_id` set in the
same statement. That is the ordinary order of events: the branch is taught,
somebody then opens the task, and the second teaching is what files it.
Teaching without an id leaves the earlier answer standing rather than unfiling
it — nothing here is a way to say "this was not that work".

No decision record. 0008 already says a run links to a task, that the task is
never required and never a key; this gives the other two entry points what the
first one had. Nothing about the label is reversed, and nothing new depends on
a task being present.

## Assumptions

- A task is still opened only by a person, on the dashboard. Neither new flag
  creates one, and both `/gate:run` and `/gate:teach` are told not to invent an
  id.
- Teaching under a task is worth refusing outright rather than storing and
  ignoring: a teaching filed into another family's work is the failure the
  family boundary exists to stop, and it would be invisible from both sides.

## Baseline

`npm test` — 692 passing, 1 skipped, green. `npm run typecheck` clean.

## Documentation

`docs/design/cross-team.md`: the task ledger says work is filed when it is
recorded and names all three entry points, the key files list the three, and a
pitfall records that a run names its task once and can never be re-filed. One
changelog line under Unreleased.

## What was built

1. `src/client/step.ts` — `begin` takes `{ taskId }` and sends it with the run.
2. `src/client/cli.ts` — `gate begin --task-id` and `gate teach --task-id`,
   both in the usage text.
3. `src/lib/client-api-schemas.ts`, `src/app/api/v1/memory/teach/route.ts`,
   `src/memory/teach.ts` — the field, the family check, the id on the created
   execution, and `COALESCE` on a second teaching.
4. `plugins/gate/commands/run.md`, `plugins/gate/commands/teach.md` — when to
   pass it and when not to.
5. `tests/memory-teach.test.ts` — a teaching filed under a task, a task outside
   the family refused with nothing stored, and a second teaching naming the
   task the first did not. `tests/cli-inputs.test.ts` — `--task-id` takes its
   value and leaves the trailing task sentence whole.

## Done when

- A session run and a taught branch can be filed under a task, as a headless
  run already could.
- A task outside the caller's family is refused in one wording, whichever
  surface asked.
- A branch taught before its task existed can be taught again to file it.
- The suite and the typecheck are green.
