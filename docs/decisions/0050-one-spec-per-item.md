# 0050. One spec per item, written when the item is finished

Status: accepted
Date: 2026-09-29
Run: manual

## Context

The record table that `/gate:init` puts in a repository's `CLAUDE.md` said "Finished a task → write `docs/specs/YYYY-MM-DD-<topic>.md`". In a Claude Code session without the pipeline, every request is a task. So a session wrote a new spec after each fix, correction and review round, and one item could end up with half a dozen specs that each describe a slice of it.

`ulak-desktop` fixed this in its own `CLAUDE.md`, but the fix stopped there: the reference that `/gate:init` copies still had the old row. Init also skipped a record section that was already present, so a repository initialised earlier would keep the old wording for good.

## Decision

A spec is written when a whole item is finished: when the user says it is done, or when it is being committed or sent as a merge request. There is one spec per item. If the branch or the topic already has a spec, that file is updated in place. Follow-up fixes, corrections and review rounds never create a new one.

The reference's table carries this row. Init writes it into new `CLAUDE.md` files. Where an existing `CLAUDE.md` has the record section in an older wording, init replaces that section with the current one, because the section is gate's and not the team's.

## Rationale

A spec is the list entry for what was built: "the directory is the list of everything that was built". A list with one entry per edit is a commit log in the wrong place, and it buries the one spec that says what the item was for.

"Task" meant a run to the pipeline and a request to a person, and the second reading produced the flood. "A whole item", with the moments that end one, can be read only one way.

Replacing an old record section differs from the rule that init leaves the team's lines alone. The section's wording comes from the reference, so bringing it up to date changes nothing the team wrote.

## Alternatives

Fix the wording in each repository's `CLAUDE.md` by hand. Every repository initialised before the fix keeps the flood until someone notices it there.

Drop specs for work done outside the pipeline. The list would then miss every item a person built in a plain session, which is the case the table exists for.

## How it works

`plugins/gate/reference/docs.md` has the new row and adds "a new spec for an iteration on an item that already has one" to *Not required*. Step 4 of `plugins/gate/commands/init.md` replaces an older record section with the reference's. Gate's own `CLAUDE.md` carries the same row.

## Consequences

A second run of init on a repository initialised before this change rewrites its record section. The step 5 report and the diff show it like any other correction.

The pipeline's `record` node still looks for a new file under `docs/specs/` in each run. A run that continues an item which already has a spec has to satisfy that node some other way. This decision does not change the node.

## Touches

- `plugins/gate/reference/docs.md`
- `plugins/gate/commands/init.md`
- `CLAUDE.md`
- `docs/design/dev-workflow.md`
- init

## Supersedes

none
