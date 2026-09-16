# 0006. A repository is taught one feature at a time, not all at once

Status: accepted
Date: 2026-09-16
Run: manual

## Context

`/gate:init` writes a repository's record for the first time: the map, a
design doc per key part, and the decision records the code and the history
show. Those documents are only half the point. The other half is that the
team's memory should hold them, so the first planner in that repository is
briefed on work finished years before gate existed, and so a sibling team
asking "how did they build this" finds an answer.

The recorder already reads decision records and design docs out of a run's
diff (0005), and `gate teach` already turns a finished branch into a run the
recorder reads. So the road exists: commit the documents, teach the branch.
The question is how much of the repository one teaching covers.

## Decision

One teach per feature. `/gate:init` commits each design doc together with the
decision records that belong to it, then runs
`gate teach --base HEAD~1 --account-file <file>` on that one commit, and
repeats. The map, `CLAUDE.md`, the changelog and `docs/plans/.gitignore` go
in a last commit that is not taught at all.

## Rationale

The recorder's answer carries exactly one feature: `answerSchema` in
`src/memory/extract.ts` has `decisions` as an array of up to thirty and
`feature` as a single object, and `upsertImplementation` writes one
implementation row per run. A teaching of a whole repository would therefore
produce one catalogue entry — the repository itself — with every decision
filed under it. That is the entry a sibling team's recall would match on,
and it would tell them nothing: the point of the catalogue is that "offline
sync" on android finds "offline sync" on desktop.

Committing feature by feature also makes the range trivial to name. `HEAD` is
the commit just made and `HEAD~1` is the one before it, so no new flag, no
detached checkout and no change to the CLI is needed at all.

## Alternatives

One teach for the whole init branch. Rejected for the reason above: one
feature card for a repository is a catalogue with one useless row.

A `--head <ref>` flag on `gate teach`, so init could write everything, commit
once, and then teach each feature's commit range without moving the working
tree. Rejected as unnecessary: committing one feature at a time gives the
same ranges with `--base HEAD~1`, and a flag that exists for one caller is a
flag to keep working afterwards.

Writing straight into memory from the client, bypassing teach and the
recorder. Rejected: there is no such endpoint, and adding one would mean a
second way for records to be created, with its own validation and its own
bugs. The recorder is the only writer, deliberately.

Teaching nothing and letting the documents reach memory on the first real
run. Rejected: the first run's diff carries only what that run touched, so
the rest of the repository would stay unrecorded until every part of it
happened to be changed.

## How it works

Init writes all the documents first and reports them, committing nothing.
If the person agrees to teach, it opens `gate-init`, and then per feature:
commit the design doc and its decision records with a `Documents:` line in
the body; write the seven-field account, whose `implementation` is the design
doc's *How it works* and whose `pitfalls` are its *Pitfalls*; teach that
commit with `--base HEAD~1`. The recorder reads the account as the run's
steps and the documents out of the diff, files the decisions under one
feature, and writes the team's implementation summary from the design doc.

The caps bound what one teaching may carry: a document is read to 6 000
characters and all documents together to 60 000, the diff is capped at 4 MB
by the client, and a teaching records at most thirty decisions. A feature
whose documents exceed those is a feature whose design doc is too long to be
read by a person either.

## Consequences

Initialising a large repository costs one recorder run per feature, which is
why init shows the list of parts and lets the person choose before it writes
anything. The cost is visible and theirs.

Re-teaching the same range replaces the earlier teaching rather than adding a
second copy, so running init again on a repository that has grown is safe.
A range a real run already recorded is refused unless `--force` is passed.

A repository with no git remote records its decisions with no repository
name, so their paths are not scoped to it. The decisions are still recorded;
searching by path across repositories is what suffers.

The features taught by init are recorded as `shipped`, like any taught
branch, with the init commit as their head. The commits describe when the
record was written, not when the feature was built; the design doc and the
decision records carry the substance, and `git log` on the code carries the
dates.

## Touches

- `plugins/gate/commands/init.md`
- `plugins/gate/reference/docs.md`
- `docs/design/dev-workflow.md`
- memory
- teach

## Supersedes

none
