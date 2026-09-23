# 0041. Merges made without gate are recorded only when the gate is set to

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

The record index (0038) reads what a repository's documents say, and that costs nothing. A team that works without gate and writes few documents still leaves nothing a sibling's recall can use about *why*. The decisions are in its merged commits' messages and diffs, and only a model can write them up. `/gate:teach` does that one branch at a time, when a person asks.

## Decision

With `memory.recordMerges` on (off by default), every commit that reaches a connected repository's base branch through its first parent, after the index first read it, and that is not a gate run's work, is kept as a finished run of `gate:merge`. The merged commits' messages and files take the place of a run's steps, and the documents in the merge's diff are included. The ordinary recorder records it, with the outcome `merged`.

## Rationale

The record should come through one door. A merge kept as a run is read by the same recorder, filed under the same features, and searched the same way as everything else, so nothing downstream has to learn about it.

It is off by default because each merge is a model call, and it starts at the first read because a repository's whole history is `/gate:teach`'s job, done on purpose with a person saying what the commits cannot. Both follow the rule already on the Memory page's backfill: a model call per item is a button, not something that happens quietly.

Gate's own work is skipped: a merge whose commits a run published or worked on, or that names a `gate/run-` branch. That work is already recorded by its run, and recording it twice would split its decisions.

## Alternatives

Record every merge always. The cost would be invisible and would scale with other teams' activity.

Summarise merges into the documents instead of decisions: write design docs for the other team. That writes into another team's repository, which gate does not do.

Leave it to `/gate:teach`. That remains the way to bring in the past. Without this there is no way to keep up with the present for a team that does not run gate.

## How it works

When the setting is on, the index keeps a watermark per repository (`merges_seen`). On each read it walks the first-parent commits between the watermark and the new base commit, 20 at most per read. For each one it takes the range the commit brought in: the second parent's range for a merge, the commit itself otherwise. It skips ranges gate already knows, then creates the run with a `merge` step holding the task (the merge's subject), the commits and the files. The workspace names the range. The diff kept is the documents' part. `outcomeOf` returns `merged` for `gate:merge`, and the recorder's prompt tells it where a reason is not written anywhere to say so.

## Consequences

A repository with no team is not recorded this way, because a run needs a team.

A squash merge of a gate run's branch whose message does not name the branch, and whose commit gate never saw, is recorded again as a merge. Its decisions then appear twice, once from the run and once from the merge, until one is forgotten from the dashboard.

## Touches

- `src/memory/merges.ts`
- `src/memory/record-index.ts`
- `src/memory/extract.ts`
- `src/memory/types.ts`
- `src/lib/settings.ts`
- `src/components/settings-panel.tsx`
- memory

## Supersedes

none
