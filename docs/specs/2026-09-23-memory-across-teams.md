Status: done
Branch: gate/memory-best-practices
Decisions: docs/decisions/0035-an-unfinished-run-is-not-a-refusal.md,
docs/decisions/0036-a-decision-belongs-to-the-repositorys-team.md,
docs/decisions/0037-words-read-every-repository-paths-stay-in-their-own.md,
docs/decisions/0038-the-repositories-record-is-read-by-code.md,
docs/decisions/0039-work-in-flight-is-part-of-recall.md,
docs/decisions/0040-a-decision-number-is-checked-against-the-remote.md,
docs/decisions/0041-merges-made-without-gate-are-recorded-when-asked.md
Design: docs/design/record-index.md (new), docs/design/memory.md,
docs/design/cross-team.md, docs/design/the-record.md,
docs/design/dev-workflow.md, docs/ARCHITECTURE.md

# Memory that works across teams

## What was asked

One parent team with several teams under it (ulak → android, desktop, server, ios). Each team should be able to learn from the others' work. Four cases:

- what the other teams are doing now;
- why a past mistake was made;
- how something that used to work broke;
- how another team integrated something.

When a team starts something another team has already built, it should be told "they did it this way; do it like this". The ask was to analyse the architecture of the record (markdown in repositories, SQLite on the server), fix what is wrong, make it best practice, borrow from outside tools where they help, and not ask questions.

## What the analysis found

These were measured on the live gate (10.0.80.35) and in this repository's history:

- **Other teams were empty.** All 13 decisions in the tree were desktop's. The documents in the other teams' repositories were invisible, because memory saw a document only in a run's own diff.
- **Most decisions read as closed roads.** 12 of the 13 were `abandoned`, and recall told the planner an abandoned attempt was a road already found closed. One of those runs, 3115ea44, was stopped for being slow, and its work was later merged by hand.
- **Chores were recorded as decisions.** Examples: updated test mocks, regenerated build output.
- **Decisions were filed under the wrong team.** gate's own repository's decisions sat under `desktop`, because a decision was filed under whoever ran it.
- **Words could not cross repositories.** A search in words from a named repository hid every other repository's decisions, so "how did android do this" could not reach android.
- **`pr-open` never became `merged`.** Nothing watched the base branch.
- **Decision numbers collided across branches:** 0018, 0021, 0022, 0023, 0030 and 0033 were each taken twice. Memory lost the renumbered record.
- **Only finished runs were visible.** Nothing showed a run in flight, and nothing was pushed to anyone.
- **Search was English-only.** Porter stemming does nothing for Turkish.

The outside tools (Graphiti/Zep, Mem0, Letta, Cognee, GraphRAG, Basic Memory, Backstage, MADR, GitHub Copilot Memory) were compared. None was adopted whole: they are Python or need a graph server, they extract with a model what the documents already state, and none knows about git base branches. Their ideas were taken: bi-temporal validity (already in the table), checking a decision against the current code (Copilot Memory), a deterministic check before planning (PROJECTMEM), and ownership and interfaces between components (Backstage).

## What was done

- **The record index** (`src/memory/record-index.ts`). Every connected repository's base branch is read by code, on a timer and on request, into derived tables: documents, full-text, interfaces. A design doc's file name is its feature's id across the tree. The same read handles decisions recorded from runs:
  - it promotes them to `merged` (by ancestry, or by their decision record for a squash merge);
  - it follows renumbered records by slug;
  - it closes decisions whose record was superseded on the branch;
  - it marks decisions whose files are all gone.

  `gate memory history` and `memory_history` give a path's commits with their `Documents:` lines and runs.
- **The verdict.** `verdict: rejected` with a reason is separate from `outcome`. Only a refusal is a closed road. The recorder records no housekeeping.
- **Ownership.** A decision belongs to its repository's team, and the running team is kept as the author.
- **Search.** A search in words reads every repository of the tree, own team and repository first, and each card names its repository. A path search stays in its own repository. Long words also match by a prefix, which reaches roots through suffixes in any language.
- **Work in flight.** Search results carry other people's running runs with the same words. A run that starts on another team's running work messages both people once, on Telegram. `gate memory activity` lists everything in flight.
- **Recall, planner and consolidator prompts.** They cover in-flight work, other repositories' design docs, interfaces, "refused before" versus "unfinished attempts", "what changed here", and code that is gone.
- **The `record` node.** In dev, dev-auto and dev-quick it checks decision numbers against the remote's base branch before the branch is offered.
- **Merges without gate**, recorded as `gate:merge` runs when `memory.recordMerges` is on (off by default).
- **The Memory page and Settings.** The page shows each repository's read, the documents, the interfaces and the in-flight runs. Settings has two new memory fields.

## What counted as done

- `npm run typecheck` clean.
- `npm test` green, including new suites that build real git repositories:
  - `tests/record-index.test.ts`: documents, features, interfaces, merged by ancestry and by squash, renumbered records, superseded records, gone files, history;
  - `tests/record-numbers-merges.test.ts`: the shipped `record` script run with `sh` in three workflows, and merges recorded and skipped;
  - `tests/memory-verdict-owner.test.ts`;
  - `tests/memory-activity.test.ts`.
- `npm run docs:check` clean, 0007 marked superseded in part by 0037.
- Version 0.45.0 in `plugin.json`, `marketplace.json` and `GATE_VERSION`. The changelog was released and the CLI rebuilt.

## Left for the person

- On the live gate: update the server, then run `npm run defaults:restore -- --refresh` so the shipped recall, planner and workflows are the new ones.
- Connect every team's repository on the Repos page with its team, so the index reads it.
- Link Telegram to get overlap messages.
- Set a multilingual embedding model (for example `bge-m3`) for cross-language search by meaning.
- Decisions recorded before this keep their old team and have no verdict. Recording their runs again refiles them.
