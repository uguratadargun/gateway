# 0060. Recording a run again keeps what other rows said about its decisions

Status: accepted
Date: 2026-09-29
Run: manual

## Context

Record again deleted a run's decisions and wrote new ones. What the old ones had closed stayed closed with nothing pointing at it, a later decision's `supersedes` pointed at a deleted id, and objections against them could no longer be found by id.

## Decision

A new decision with the same title (trimmed, case-insensitive) as an old one is that decision read again. It takes over the pointers to the old one, its objections, its `valid_to` and retraction, and what it closed, which it now names. An old decision with no such heir reopens what it closed, as forgetting it would.

## Rationale

Recording again re-reads the same run. The recorder rewrites its prose but keeps the titles it gave, and what other runs and teams said about a decision is not the recorder's to erase.

## Alternatives

Match old to new by position. The order changes between readings.

Reopen everything and let later passes close it again. Consolidation does not run again for decisions it already counted, and objections would stay orphaned.

Refuse Record again when anything points at the run. That blocks fixing a bad reading.

## How it works

In one transaction the old rows are deleted, what each old decision with no same-title draft closed is reopened, the new decisions are inserted, and for each old decision the `supersedes` pointers and objection `decision_id`s move to its heir, `valid_to` and `retracted_at` carry over, and the heir's `supersedes` is set when it names nothing itself.

## Consequences

A renamed decision loses its links, the same as a forgotten one. Objections keep their snapshot and paths.

## Touches

- `src/memory/store.ts`
- `src/memory/forget.ts`
- `docs/design/memory.md`
- memory

## Supersedes

none
