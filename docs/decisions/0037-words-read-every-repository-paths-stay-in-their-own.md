# 0037. Words read every repository of the tree, paths stay in their own

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

Decision 0007 gave repositories an identity. On the read side it also ruled that a caller who knows its repository hides decisions belonging to any other named repository. The failure it was preventing was about paths: `src/index.ts` exists in four repositories, and a path lookup answered with another repository's constraint.

The rule applied to searches in words too. A run in the desktop repository asking "how did android do offline sync" had android's decisions filtered out before ranking. The only way across was the feature catalogue, and only when the recorder had filed both teams' work under the same entry. The one question the team tree exists to answer was blocked in the common case.

## Decision

A path search stays in the asker's repository: decisions of another named repository are hidden, and unnamed ones are kept, as 0007 said. A search in words reads every repository of the tree, ranks the asker's own team first and then its own repository, and every card names its repository. `ask`, which answers about one commit of one repository, filters to that repository itself.

## Rationale

A relative path means something only next to its repository. Words mean the same across repositories. That is why a sibling's decision is found by words.

Naming the repository on every card makes the stranger in the answer visible. 0007's worry was a constraint read without knowing where it came from. A card that says "repo: github.com/ulak/android" is the opposite of that.

Ranking keeps the asker's own work in front, so an answer about this codebase still comes first when both match.

## Alternatives

Keep the filter and rely on the feature catalogue. It depends on a model filing two teams' work under one entry, which the live data shows it often does not: 7 of 13 decisions had no feature at all.

Drop the filter everywhere, paths included. That brings back exactly the collision 0007 fixed.

A flag the asker sets to widen the search. The planner does not know it needs another repository's decision until it has seen one.

## How it works

`searchDecisions` applies the repository filter only when the search has paths. The full-text branch orders by own team, then own repository, then bm25. `toDecisionCard` carries `repo`, and the text a model reads prints it. `memoryAt` in `ask` keeps only decisions of the repository being asked about, or unnamed ones, before splitting them by the commit's history.

## Consequences

A search in words from inside a repository can return decisions about other repositories' code. Their paths are not this repository's, and the card says so.

0007's other rulings stand: identity is the remote, unknown is never guessed, and supersession stays inside one repository.

## Touches

- `src/memory/store.ts`
- `src/memory/types.ts`
- `src/memory/cards.ts`
- `src/orchestration/ask.ts`
- memory

## Supersedes

0007, in part: its read-side rule for searches in words. Identity, the null rule, backfilling and the supersession check all still hold.
