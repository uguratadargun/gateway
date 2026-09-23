# 0038. The repositories' record is read by code, and the base branch settles what landed

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

Each repository keeps its own record, as 0005 set out: design docs, decision records, specs. Memory was meant to index them. In practice memory saw a document only when a run's own diff added it and a model (the recorder) read it out of that diff. So:

- A record edited on the base branch by hand never reached memory.
- A sibling team's design doc was invisible to recall unless a run of theirs had written it.
- A repository whose team did its work outside gate was empty. On the live gate that was every team except desktop.

The same gap left three facts about recorded decisions unobserved:

- Whether the work landed: `pr-open` never became `merged`, and a failed run that was merged by hand stayed `abandoned`.
- Whether a decision's record had been renumbered: six numbers were taken twice across branches, and a path search for the renumbered record found nothing.
- Whether the code a decision describes still existed.

## Decision

A record index reads every connected repository's base branch, with code and git and no model. It reads on a timer (`memory.indexEveryMinutes`, 15 by default) and on request. It keeps each design doc, decision record, spec and map as a row of its own, searchable and scoped like decisions. Its rows are derived: dropping them and reading again loses nothing.

A design doc's file name is its feature's id in the tree's catalogue, and its Interfaces section says what the feature provides and consumes.

The same read settles three facts about recorded decisions:

- A decision whose head (or published commit) is in the base branch's history, or whose decision record is on it, becomes `merged`.
- A decision's touch follows its record to a new number by slug.
- A shipped decision whose every file is gone from the base branch is marked as describing code that no longer exists.

The history of a path is read from the checkout on request, every commit included, each with its `Documents:` line and its run.

## Rationale

The documents have a form that code checks (0021), so reading them needs no judgement, and anything that can be read by code should not cost a model call or depend on one's reading. The files stay the source. The index is a view of them, so it can never disagree with them for longer than one read.

Reading the base branch, and not a run's diff, is what reaches the teams that do not use gate, and the edits made by hand. The base branch is also where those three facts about decisions are true. Before this, "merged" was a word nothing assigned, and a sibling planner could not tell a merge request left open from shipped work.

The file name as feature id makes the catalogue deterministic across repositories: `offline-sync.md` in android's repository and in desktop's is the same feature without a model matching two names. The Interfaces section turns "who has to follow if the server changes this, and how did each of them integrate it" into a lookup.

History is read on request, not copied, because git already stores it and a copy would only fall behind.

## Alternatives

A temporal knowledge graph service (Graphiti/Zep, Cognee, Mem0's graph memory). These bring Python or a graph server into a Node and SQLite gate, extract facts with a model where the documents already have structure, and have no notion of a git base branch. Their useful idea, bi-temporal validity, the decisions table already has.

Have the recorder read the whole repository's docs after each run. Every run would pay a model to reread files that did not change, and a team that never runs gate would still be invisible.

Watch merge requests through the host's API for `merged`. That needs a token per host and still misses a branch merged by hand. The base branch's history answers for every host, and a squash merge is caught by the decision record it carries.

Copy the commit log into a table for path history. That duplicates git and goes stale between reads.

## How it works

`indexRepo` resolves the base ref: the repository's base ref, or else the remote's HEAD. It fetches that ref into `refs/gate/record/base`, which is the index's own ref so a concurrent `ask` fetch cannot move it, and lists `docs/` at that commit. A document whose blob hash is unchanged is not read again. A changed one is parsed into its kind, slug, number, title, status, date, summary and interfaces, and written with its full-text row. A document gone from the branch is deleted. A design doc opens its feature in the tree root's catalogue if the catalogue lacks it.

Then it reconciles:

- Decisions not refused and not yet landed are checked for ancestry, then for their decision record's slug on the branch.
- Touches under `docs/decisions/` that are not on the branch follow a unique slug to its path.
- Decisions whose record is marked superseded on the branch are closed.
- Shipped decisions have their file touches counted against the tree.

`historyOf` runs `git log` at the indexed commit on the asked paths. Search returns documents and interfaces beside decisions. A feature's detail carries every repository's design doc. The Memory page shows each repository's read, and it has a button to read them all now.

## Consequences

A repository has to be connected on the server, with a checkout, for its record to be read. A team that works only on laptops is read once its repository is connected. That is a one-time setup, not a per-run cost.

The squash-merge rule trusts a decision record's slug. A different record with the same slug on the base branch would promote a decision that did not land. Slugs are titles, and that collision is rare and visible.

The index sees the base branch only. Work on open branches is what recall's in-flight list and published branches (`ask`) are for.

## Touches

- `src/memory/record-index.ts`
- `src/memory/hybrid.ts`
- `src/memory/access.ts`
- `src/memory/store.ts`
- `src/memory/embeddings.ts`
- `src/lib/db.ts`
- `src/instrumentation-node.ts`
- `src/app/api/memory/index/route.ts`
- `src/app/api/v1/memory/history/route.ts`
- `src/runtime/tools/memory-tools.ts`
- `plugins/gate/reference/docs.md`
- memory

## Supersedes

none — 0005 said memory indexes the record; this is how
