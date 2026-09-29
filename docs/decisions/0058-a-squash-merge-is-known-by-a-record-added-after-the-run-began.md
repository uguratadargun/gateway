# 0058. A squash merge is known by a record added after the run began

Status: accepted
Date: 2026-09-29
Run: manual

## Context

The record index promotes a decision to `merged` when the decision record its run wrote is on the base branch, because a squash merge leaves no commit of the branch. It treated any decision record the decision touched as one the run wrote. A run that supersedes an older record edits that record's Status line, so the older record is among its touches, and it is on the base branch from the start. The open merge request's decision became `merged` on the next index pass.

## Decision

A touched decision record counts for a squash merge only when the commit that first added it to the base branch is later than the moment the run began.

## Rationale

A run can only have written a record that did not exist before it started. The base branch's own history says when each record appeared, so the test needs nothing the run may not have kept.

## Alternatives

Check that the record is absent at the run's base commit. That fails when the base is unknown or not in the checkout.

Check the run's stored diff for a new file. The diff can be cut short.

Drop the squash rule. Squash merges would never be recognised.

## How it works

For each decision awaiting merge whose commits are not in the base history, each touched decision record's path on the branch is found by slug, the author time of the commit that added it (`git log --diff-filter=A`) is read, and it is compared with the run's `started_at`.

## Consequences

A different record with the same slug, added after the run began, still promotes the decision. A committer clock far behind the gate's can hide a real squash merge.

## Touches

- `src/memory/record-index.ts`
- `docs/design/record-index.md`
- record-index

## Supersedes

none
