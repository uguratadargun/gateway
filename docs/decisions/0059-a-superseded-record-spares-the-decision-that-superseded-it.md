# 0059. A superseded record spares the decision that superseded it

Status: accepted
Date: 2026-09-29
Run: manual

## Context

A decision record whose Status says "superseded" closes the decisions that touch it. The run that superseded it edited that Status line, so its own new decision touches the old record too, and it was closed along with it.

## Decision

When record N's Status names "superseded by M", decisions that also touch record M stay open.

## Rationale

The Status line names the record that superseded it, and touching that record is what marks the new decision.

## Alternatives

Close only decisions whose run added record N. That needs a history lookup when the Status line already names the new record.

Stop closing by record. Decisions whose record was replaced would keep holding.

## How it works

The number is parsed from the Status, the records with that number on the branch are found, and their paths are passed to `closeByRecord`, which leaves out decisions touching any of them.

## Consequences

A Status line without a number closes every decision that touches the old record, as before.

## Touches

- `src/memory/record-index.ts`
- `src/memory/store.ts`
- `docs/design/record-index.md`
- record-index

## Supersedes

none
