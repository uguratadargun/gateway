# 0052. A run's owner keeps it when they move to another team

Status: accepted
Date: 2026-09-29
Run: manual

## Context

Moving a person to another team moves their keys with them. The client API's ownership check compared a run's team with the key's current team first, so after a move every finish, report, continue and cancel on a run the person had in hand was refused with 403. The worktree and the session driving the run are on their machine, and nobody else can reach them. A running run sat until the six-hour silence sweep wrote it off, and a run paused on the person was never swept at all.

## Decision

A run with an owner can be reported on, finished, continued and stopped by that owner, whichever team they are on now. The run stays filed under the team it was started in. Anyone else is held to the old rule: same team, and the owner if there is one. A key with no person behind it reaches only runs that have no owner.

## Rationale

The run is the person's work in progress on their own disk. Refusing them does not protect the old team's data: the run's steps, worktree and pinned definitions are already on their machine. It only leaves a run nobody can end. Filing stays where it was because the run was done under the old team's workflow and its memory belongs to that team.

## Alternatives

Settle the person's running runs when they are moved. That throws away work in progress because of an admin action taken for another reason.

Move the runs to the new team. That files work under a team whose workflow did not produce it, and its memory lands in the wrong tree.

Leave it and let the sweep write the run off. A paused run is never swept, so it stays running until someone notices.

## How it works

`ownsExecution` in `src/lib/tenancy.ts` lets a principal through when both it and the run have a user id and they are equal. Otherwise it applies the team check and then the owner check as before. The client stream checks the key again on every heartbeat and closes when its team changes, so the client reconnects under the new team; the owner rule still admits their old runs by id.

## Consequences

A moved person's `gate status` lists their new team's runs. A run from before the move is reached by its id, which is what `gate continue` and the run's own session use. A moved person still writes steps into a run filed under a team they have left: their own run and nothing else of that team.

## Touches

- `src/lib/tenancy.ts`
- `src/app/api/v1/executions/stream/route.ts`
- `docs/design/teams-and-keys.md`
- `docs/design/executions.md`
- teams-and-keys

## Supersedes

none
