# 0053. One gate command works on a run at a time

Status: accepted
Date: 2026-09-29
Run: manual

## Context

`gate next` runs every command node up to the next agent node: commit, push, `gh pr create`. Two commands on one run — a backgrounded `gate step` and a `gate next`, or two sessions — both found the same unrecorded command node and ran it. The server kept the first step, but the push happened twice. The documentation called `next` free of side effects.

## Decision

`begin`'s walk, `next`, `step` and `continue` each hold `~/.gate/runs/<id>.lock`, holding the process id, while they work. A second command on the same run is refused and names the holder. A lock whose process is gone is taken over.

## Rationale

Refusing is honest and cheap, and the session asks again. Waiting would hide that a second driver exists. Taking over a stale lock keeps a killed command from locking the run for good.

## Alternatives

Make `next` read-only and move command execution into `step`. That reshapes the protocol every session follows.

A lease on the server. It needs a round trip and server changes, and only adds cover for two machines driving one run.

Wait for the lock. A session would block for minutes behind a test run.

## How it works

The lock file is created exclusively. If it exists and its process is alive, the command is refused; otherwise the file is removed and creation is tried once more. The lock is reentrant within one process, because `step` calls `next`, and it is removed in a `finally`.

## Consequences

A second `gate next` during a long command node is refused rather than answered. Two machines driving one run are still not prevented.

## Touches

- `src/client/step.ts`
- `plugins/gate/commands/run.md`
- `docs/design/dev-workflow.md`
- dev-workflow

## Supersedes

none
