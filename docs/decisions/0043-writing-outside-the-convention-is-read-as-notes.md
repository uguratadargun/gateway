# 0043. Writing outside the convention is read as notes

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

The record index (0038) read only the convention's four places: `docs/design/`, `docs/decisions/`, `docs/specs/` and `docs/ARCHITECTURE.md`. The first repository it read on the live gate, the desktop app, returned no documents at all. Its writing is real and current, but it sits elsewhere: `docs/mention-system.md`, `docs/attachment-upload-queue.md`, `docs/superpowers/specs/…`. Every repository that predates the convention looks like this, and until someone runs `/gate:init` and merges the result, nothing it wrote reaches another team.

The same read kept only a design doc's Summary as its summary, so a sibling reading the feature's page saw how it works but not the Pitfalls. Those are the one section written for the next person to build the thing.

## Decision

Every other Markdown file under `docs/` is read as a `note`, except the pipeline's `docs/plans/` and misnamed files under `docs/design/` or `docs/decisions/`. Up to 400 notes are kept per repository, taken newest-named first. A note is found by search and shown as written outside the convention. It is never a feature's page, never a decision, and never reconciled against. A design doc's Pitfalls section is kept apart from its Summary and shown with it.

## Rationale

Writing a team already did is the cheapest record there is, and it is the one most likely to be true of how the code was meant to work. Hiding it until it has been rewritten into the convention's form makes the convention a toll.

Keeping notes separate from the four kinds is what lets them in safely. A note's file name is not a feature id and its sections are not a decision's, so nothing that depends on the convention's form reads them as if they had it.

The cap keeps a `docs/` that is really an archive from filling recall. Newest-named first favours the dated write-ups that are most likely still true.

## Alternatives

Read only the convention, and rely on `/gate:init` to move everything in. Nothing is found in the meantime, and init does not move files (0042).

Read notes as design docs when they look like one. Guessing a feature id from a free-form file name produces the second-name problem the tree's naming exists to prevent.

Index every Markdown file in the repository. READMEs of vendored packages and changelogs of dependencies would swamp it, and `docs/` is where a team puts writing it means to keep.

## How it works

`recordKindOf` returns `note` for a `.md` path under `docs/` that matches none of the four kinds and is not under `plans/`, `design/` or `decisions/`. Its slug is the file name, and its date is any date in the path. The index lists `docs/` whole and keeps up to 400 notes. The rows are the same as other documents', so they are searched and embedded like any other, and they are deleted when the file goes.

A design doc's Pitfalls go into their own column. A row read before that column existed is read again once.

## Consequences

A search may return a note that is out of date. The card says it is outside the convention, and the design doc, when there is one, ranks beside it.

A repository with more than 400 notes has its oldest-named ones left out.

## Touches

- `src/memory/record-index.ts`
- `src/memory/cards.ts`
- `src/lib/db.ts`
- memory

## Supersedes

none
