# 0004. The plan file is never committed

Status: superseded by 0005
Date: 2026-09-10
Run: 23b2a15 (gate: 0.31.0 — the commit that introduced the `plan-dir` node)

## Context

The dev pipeline's planner writes its plan to `docs/plans/YYYY-MM-DD-<topic>.md` in the run's worktree, and the implementer, verifier and reviewer read it from there by section name — Goal, Approach, Assumptions, Baseline, Tasks. The implementer commits as it goes, one commit per task, and a `git add` of the tree in that worktree would sweep the plan file into the first commit and from there into the merge request. The plan is working material: a revision is a new file with the pass in its name (`…-rev2.md`), so the implementer's ledger cannot mistake a revised plan for done work, and it says what the run set out to do in the planner's words rather than what the branch delivers.

The run's worktree is a linked worktree of the person's checkout, so the usual tool for ignoring something locally — `info/exclude` — is the common one, shared with the person's own checkout, and a rule put there would outlive the run.

## Decision

The plan file stays on disk and out of the commit. A `plan-dir` command node, run before recall and the planner, creates `docs/plans/` and writes a `.gitignore` of `*` into it, so the directory — itself included — is ignored for this worktree's tree and nothing else. The planner is told to write the plan there and not commit it; the pipeline commits what the run produced once it is approved, and the reasoning the plan carried travels in the implementer's summary, which is the commit's body.

## Rationale

A `.gitignore` of `*` inside the directory ignores everything in it, the `.gitignore` itself included, so nothing about the plan reaches the index, the commit or the merge request, and the rule lives in the one tree it applies to. It is only written when there is not one already, so a project that ships its own `docs/plans/.gitignore` keeps it.

The reasoning is not lost by being uncommitted: the implementer's summary of each task, which the pipeline writes into the commit body, is where the plan's "why" lands in the repository's history.

## Alternatives

Commit the plan with the work. The plan is the run's draft, revised per pass; the branch would carry every revision as history, and the merge request would show a document its reader did not ask for and that says less than the commit bodies do.

Use `info/exclude`. In a linked worktree that file is the common one, shared with the person's checkout, so the rule would outlive the run and touch the person's own tree.

Delete the plan when the run ends. The verifier and reviewer read it during the run, and the person may want to read it on the finished branch before accepting; deleting it removes the record from the one place it still exists.

## How it works

The `dev` graph runs `base` (record the starting commit), then `plan-dir`:

    mkdir -p docs/plans && { [ -e docs/plans/.gitignore ] || printf '*\n' > docs/plans/.gitignore; }

then `recall` and `planner`. The planner writes `docs/plans/YYYY-MM-DD-<topic>.md` and, on a revision, a new file with the pass in its name, never committing either. The implementer, verifier and reviewer read the plan by path; the implementer's summary carries the reasoning into each commit body. The commit node at the end commits what the run produced, and the plan is not among it because git does not see it.

## Consequences

The plan exists only in the worktree. Once the run's worktree is tidied (`gate clean`, or when the run ends and its branch keeps the work), what was asked and what counted as done survive only in commit bodies and in gate's execution record; the repository itself carries no spec of the change.

0005 supersedes this record for that reason. It keeps the plan uncommitted — `docs/plans/` stays gitignored and is still the pipeline's working directory — but has the implementer copy the plan's final revision to `docs/specs/YYYY-MM-DD-<topic>.md` when the last task is committed, under a block naming the run's branch and the decision and design documents it wrote. The `-rev2` suffix is dropped in the copy: the spec is the plan as finished, not each pass of it.

A project that ships its own `docs/plans/.gitignore` with a narrower rule than `*` commits whatever its rule lets through; the node does not overwrite it.

## Touches

- `src/workflows/defaults.ts` (the `plan-dir` node)
- `src/agents/defaults.ts` (the planner prompt, "The plan file")
- dev pipeline
- plans

## Supersedes

none
