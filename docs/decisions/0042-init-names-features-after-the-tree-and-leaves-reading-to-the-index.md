# 0042. /gate:init names features after the tree, and leaves reading them to the index

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

`/gate:init` writes a repository's first record. Decision 0006 then had it teach that record to memory: one commit and one `gate teach` per feature, each teach a model call that read the design doc and decision records back out of the diff.

The record index (0038) changed both halves of that. Once the documents are on the base branch of a connected repository, the gate reads them by code, for nothing. Teaching them as well costs a model call per feature and puts every decision in recall twice, once as the document and once as the recorder's reading of it.

The index also made a design doc's file name the feature's id across the tree. Init named files "as the product calls it" without looking at what the rest of the tree had already named the same feature. So the android and desktop write-ups of one feature could land under two names that never meet. Init also ignored writing already under `docs/` that was not in the convention's places, and never checked whether anybody would read what it wrote.

## Decision

Before naming anything, init asks the gate two questions:

- whether this repository is connected and read (`gate memory repo`);
- which features the tree already has (`gate memory features`, then `gate memory search` per part).

A design doc for a feature a sibling already built takes that feature's id as its file name, and an interface a sibling lists is written under the same name. The existing notes under `docs/` are read first and pointed to, never moved.

Init commits the work on a `gate-init` branch, one commit per feature and one for the skeleton, and pushes nothing. The documents reach memory when that branch is merged and the repository is connected. Teaching is kept only for a repository the gate cannot connect.

## Rationale

The file name is the join between teams now, so choosing it is the one step that decides whether init's work is found by the rest of the tree. That makes it worth two reads and a question to the person.

Teaching was the way documents reached memory when nothing else read them. With the index reading the base branch, it is a second, paid copy of the same text, and the copy drifts from the file the moment the file is edited. The file does not.

Pushing stays the person's call, as it was, because the branch reaches the base branch the way their other work does. Merging is what makes the record true of the base branch, which is what the index reads.

## Alternatives

Keep teaching every feature, and let the index read the same documents too. Every decision would appear twice in recall, and the model calls would buy nothing the index does not give.

Rename a sibling's feature to match this repository instead. That writes into another team's repository and catalogue, which gate does not do. The person can always take a different name in step 3, and init says what that costs.

Move existing notes into the convention during init. That rewrites a file the repository already has, which init has never done. The notes are read as they are (0043), and a note is moved into the convention when its feature is next changed.

## How it works

The command prints `memory repo` and `memory features` before step 1. It reads existing notes in step 2, and searches the tree for each part it found. In step 3 it shows each part with the file name it will use and whether that name is a sibling's. In step 4 the subagents get the agreed name and the sibling's design doc. Step 6 commits on `gate-init` and explains what the index does once the branch is merged and the repository is connected. The per-feature teach remains for a repository that cannot be connected. `GET /api/v1/memory/features` and `GET /api/v1/memory/repo` serve the two CLI commands.

## Consequences

A repository initialised but never connected is known to nobody but its own team. Init says so at the start and at the end.

Memory holds no recorded decisions for init's work, only the documents. Recall searches both, so a sibling still finds it. A feature's per-team page shows the design doc's summary and pitfalls in place of a recorder's summary.

## Touches

- `plugins/gate/commands/init.md`
- `src/client/cli.ts`
- `src/app/api/v1/memory/features/route.ts`
- `src/app/api/v1/memory/repo/route.ts`
- `src/memory/record-index.ts`
- `plugins/gate/reference/docs.md`
- init

## Supersedes

0006: its teaching of init's documents, one feature per teach. The one-commit-per-feature shape still holds, and so does teaching one feature at a time where teaching is still used.
