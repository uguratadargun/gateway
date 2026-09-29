Status: done
Branch: main
Decisions: docs/decisions/0052-a-runs-owner-keeps-it-when-they-move-team.md, docs/decisions/0053-one-gate-command-works-on-a-run-at-a-time.md, docs/decisions/0054-a-runs-skills-are-read-from-its-pin-then-the-mirror.md, docs/decisions/0055-a-remote-is-connected-once.md, docs/decisions/0056-forges-that-spell-a-repository-twice-are-one-name.md, docs/decisions/0057-a-give-up-edge-counts-failures.md, docs/decisions/0058-a-squash-merge-is-known-by-a-record-added-after-the-run-began.md, docs/decisions/0059-a-superseded-record-spares-the-decision-that-superseded-it.md, docs/decisions/0060-recording-a-run-again-keeps-what-others-said-about-it.md, docs/decisions/0061-a-consolidation-that-keeps-failing-waits-for-a-new-decision.md, docs/decisions/0062-as-of-a-date-means-the-end-of-that-day.md
Design: docs/design/executions.md, docs/design/teams-and-keys.md, docs/design/dev-workflow.md, docs/design/workspaces.md, docs/design/workflows-engine.md, docs/design/repositories.md, docs/design/cross-team.md, docs/design/agents-and-skills.md, docs/design/memory.md, docs/design/record-index.md, docs/design/providers.md

# The logic audit

## What was asked

Scan the whole system for logic errors, check carefully that each one really
is an error, and fix all of them in one go.

The system was read in five parts — the client's run walk, the workflow
engine and shipped pipelines, the server's run record and access control,
the team memory, and cross-team asking with repositories and skills — and
every finding had to come with a concrete failure and a reproduction. Each
part was then checked again from the other side before anything was
changed: a finding was fixed only if it contradicted the code's or the
design's own intent, and the ones that were intended, or that needed a
choice, were said to be so.

## What counted as done

- Every finding is either fixed with a regression test that fails without
  the fix, or recorded as not a bug, or left with the reason in a design
  doc's Pitfalls: a second tree's design doc whose name another tree owns
  (feature ids are global), Bitbucket Server's `/scm/` spelling, stale
  acceptance requests on later review laps, and `input.*` compared with a
  number or a boolean in a team's workflow.
- The server passes nothing a client reported to `git` as an option.
- A confirmed cross-team objection reaches the other team; a continued run
  is recorded when it finishes; the shipped give-up edges count failures.
- A run never runs commands outside its worktree, never wedges on an error,
  and is driven by one `gate` command at a time.
- Every choice made along the way has a decision record (0052–0062), and
  the design docs say what is true now.
- `npm run typecheck`, `npm test`, `npm run docs:check`, `npm run build`
  and `npm run build:cli` pass on the merged tree; the three versions are
  0.50.0.

## Not done here

- Feature ids scoped per tree: a schema change across every table that
  names a feature.
- Deploying: the live gate needs the server rebuilt and
  `npm run defaults:restore -- --refresh` for the new `dev`, `dev-auto` and
  `dev-quick`; every person needs `/gate:update`.
