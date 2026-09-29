# 0051. A run warns at its start about what its end needs

Status: accepted
Date: 2026-09-29
Run: manual

## Context

Since every run is driven from the person's own session (0047), the branch is pushed and the merge request is opened from the person's machine, with its git credentials. On a GitHub remote the merge-request node needs `gh` signed in, and it checks that only when it runs, which is after every other node has run. A machine that was never set up for `gh` finds out at the end of an hour-long run, with the branch committed and no pull request.

## Decision

`gate begin` checks for this before the first node. If the workflow has a command node with `gh pr create`, the repository's origin is on GitHub, and `gh auth status` fails on this machine, it prints a line starting with `⚠` that says to run `gh auth login`. `/gate:run` tells the session to pass that line to the person. The run starts anyway.

## Rationale

The person is at the terminal when a run starts and may not be there when it ends. A missing sign-in costs one command to fix at the start and a manual push and pull request at the end.

It is a warning and not a refusal because the check cannot know whether the run will reach the node. The autonomous road can stop at the commit (0032), and a run whose plan is rejected never gets there. Refusing would block runs that never needed `gh`.

GitLab gets no check. Without a signed-in `glab` the node falls back to push options, which use the SSH key the clone already uses, so nothing is missing.

## Alternatives

Check at `gate login`. Login does not know which repository or workflow will run, and a machine may be set up for `gh` later, or for a GitHub repository it did not have at login.

Refuse at `begin`. This blocks runs that stop before the node.

Move the pull request out of the workflow and into the client, which could then check its own needs. That takes the step out of the graph, where teams edit it and `/gate:design` adapts it to a project.

## How it works

`src/client/preflight.ts` finds the node by the text `gh pr create` in its command, skipping disabled nodes. It reads the origin of the repository the run's worktree is cut from and runs `gh auth status` once. `begin` in `src/client/step.ts` prints each warning after the worktree is made.

## Consequences

A team node that opens a pull request some other way gets no warning, and it still fails only at the end.

`begin` now runs `gh auth status` on a GitHub remote when the workflow opens a pull request. That can take a moment on a slow network, and it times out after fifteen seconds.

## Touches

- `src/client/preflight.ts`
- `src/client/step.ts`
- `plugins/gate/commands/run.md`
- `docs/design/dev-workflow.md`
- dev-workflow

## Supersedes

none
