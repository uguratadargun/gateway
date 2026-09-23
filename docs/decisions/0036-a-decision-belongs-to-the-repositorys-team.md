# 0036. A decision belongs to the repository's team

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

A recorded decision was filed under the team of whoever ran the run. On the live gate, gate's own repository's decisions sat under `desktop`, mixed in with the desktop app's, because a desktop person ran them. The same applied to work across repositories. When a desktop engineer fixed something in the server's repository, the decision became desktop's:

- The server team could not supersede it, because only a team closes its own decisions.
- An objection to it went to desktop.
- The server's page on the feature never learned of it.

## Decision

A decision belongs to the team whose repository the work was in, when the repository names a team inside the run's own tree. Otherwise it belongs to the run's team. The run's team is kept beside it as `author_team_id` whenever the two differ. Supersession, objections and a feature's per-team page all follow the owner.

## Rationale

A decision is about code, and the code's team is the one that lives with it, answers objections to it and closes it when it stops holding. Filing it under the visitor turns every cross-repository fix into a record its real owner cannot maintain.

The tree check keeps the rule from crossing company boundaries. A repository of this tree does not make a run from another tree this tree's record, and an owner outside the run's own tree is never assigned.

The author is kept, not dropped, because "who did this and why were they in our code" is a question the owner will ask. It is also the one piece of provenance the old filing had right.

## Alternatives

Keep the run's team and add the repository's team as a secondary label. Supersession and objections would still go to the wrong team. Every rule built on "only a team closes its own decisions" would need a second clause.

Ask the person which team a decision belongs to. The repository already says it on the Repos page, and asking every run for a fact the gate holds is noise.

Re-own every existing decision in a migration. That would move rows silently, together with their pages and objections. Records made before this keep their team, and recording a run again files it by the new rule.

## How it works

`ownerTeamOf(execution)` looks up the run's repository by identity. If the repository has a team that is in the run's family and differs from the run's team, that team owns the decisions. `replaceDecisions` takes the owner as `teamId` and the run's team as `authorTeamId`, and stores the author only when it differs. The recorder writes the feature's implementation row under the owner as well. A card shows "team: server (made by desktop)".

## Consequences

A team's page on a feature can now contain decisions that another team's runs made in its repository. That is the intent: the page is about the code.

The run's own team no longer finds those decisions first in its own-team ranking, because they are the owner's. It still finds them by repository and words.

Decisions recorded before this, like gate's own under `desktop`, stay where they were until their runs are recorded again.

## Touches

- `src/memory/extract.ts`
- `src/memory/store.ts`
- `src/memory/types.ts`
- `src/memory/cards.ts`
- memory

## Supersedes

none
