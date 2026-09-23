# 0040. A decision number is checked against the remote before the branch is offered

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

A decision record takes the next free number under `docs/decisions/` when it is written. Two branches open at once take the same one, and whichever merges second duplicates it. In this repository's history, 0018, 0021, 0022, 0023, 0030 and 0033 were each taken twice. The form check (0021) catches the duplicate, but only on the branch that merged second, after the merge, which is the most expensive moment to renumber. Memory kept the old path as a touch, so the renumbered record fell out of path searches.

## Decision

The shipped workflows' `record` node, which already checks that a spec was written, also fetches the remote's base branch. It names every decision record this branch added under a number the base branch already holds for a different file, with what to do. The run goes back to the implementer, who renumbers, as for a missing spec. If the remote cannot be reached, this check is skipped rather than failed. The record index follows a renumbered record to its new path by slug (0038).

## Rationale

The collision is a fact about two trees, so code checks it, and the check belongs at the last moment the branch is still the run's own, before it is offered for merge. The fix is a judgement about which pointers to move, so an agent makes it, through the same loop the spec check uses. That loop already ends on a terminal after three asks.

Checking against the remote, not the run's base commit, catches the branch that merged while this run was working, which is the case that actually happens.

Skipping when offline keeps an unreachable remote from failing a run whose record is fine. The form check and the index still catch what slips through.

## Alternatives

Numbers assigned at merge by the host's CI. That needs CI in every repository gate works in, and gate does not own their pipelines.

Dates or random ids instead of numbers. Every record in every repository, and the form check, would change, and the numbers people cite in conversation ("see 0021") would be lost.

A renumbering command that rewrites the branch without an agent. Which pointers to move is a judgement: a sentence in a design doc might cite the other 0002. An agent reads the message and the files, and the command would be one more thing to ship to every machine.

## How it works

After the spec check passes, the node runs `git fetch origin HEAD`, lists the numbers under `docs/decisions/` at `FETCH_HEAD`, and for every file this branch added since the run's base commit (committed or not) whose number is taken there by a different file, prints the file and the next free number. It exits 1. The edge sends the implementer back with that text. The node's label and edges now say "record in order" rather than "spec written". The same script is in dev, dev-auto and dev-quick.

## Consequences

Two runs that both pass the check and then both merge can still collide. The check narrows the window to the time between one run's check and the other's merge. It does not close it.

A repository whose remote is not `origin` is not checked.

## Touches

- `src/workflows/defaults.ts`
- `plugins/gate/reference/docs.md`
- dev-workflow

## Supersedes

none
