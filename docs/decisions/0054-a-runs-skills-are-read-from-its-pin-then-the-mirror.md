# 0054. A run's skills are read from its pin, then from the team's mirror

Status: accepted
Date: 2026-09-29
Run: manual

## Context

A run reads its definitions from a copy pinned at `begin`. A skill missing from the pin could never be supplied: `gate pull` refreshes only the mirror, and the node failed on every `continue`. It also announced the node, and paused the run for the person, before the skill check threw, so an `asks` node stayed paused for good.

## Decision

An agent's declared skills are resolved from the run's pin first and from the team's mirror second, before the node is announced. The node fails as a recorded step only when neither has the skill.

## Rationale

The pin exists to keep the graph and the agents still under a walking run. A skill is the process an agent follows; taking a newer or newly imported one does not move the walk.

## Alternatives

Copy skills into the pin again on `continue`. More machinery for the same result.

Keep failing and tell the person to start over. That throws away a run over a missing file.

## How it works

Skills are resolved through the run's scope, then `cacheScope(team)`. The error says to run `gate pull` and then `gate continue <id>`.

## Consequences

A skill edited in the team library mid-run is seen by that run's later nodes only if the pin lacked it; skills the pin has are still read from the pin.

## Touches

- `src/client/step.ts`
- `docs/design/dev-workflow.md`
- dev-workflow

## Supersedes

none
