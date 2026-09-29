# 0061. A consolidation that keeps failing waits for a new decision

Status: accepted
Date: 2026-09-29
Run: manual

## Context

A consolidation pass is due while a team's feature has enough new decisions since the last successful pass. A pass that failed never advanced that count, so it was due again on every drain: a model call each time, on the same input, failing the same way.

## Decision

After three failed passes over the same decisions since the last successful one, the feature is not due until a new decision arrives. The failures stay on the feature's consolidation ledger.

## Rationale

A new decision is new input and earns another try; retrying unchanged input spends without learning anything. This stops a retry, not a run, so it is not a run ceiling.

## Alternatives

Retry with a time backoff. Unchanged input still fails and still costs.

Stop after N failures for good. A feature that later gains decisions would never be consolidated again.

## How it works

`dueConsolidations` counts the failed passes that started at or after the latest successful pass and read at least `min(decision_count, 200)` decisions, and leaves the feature out when there are three.

## Consequences

A provider that is down for a while stops consolidating busy features until each gets another decision.

## Touches

- `src/memory/consolidate.ts`
- `docs/design/memory.md`
- memory

## Supersedes

none
