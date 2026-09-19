# 0022. A session gate starts begins in auto mode

Status: accepted
Date: 2026-09-20

## Context

A session on the gate server is a real interactive `claude` in a pty, started
for a person who is not at it: they are in a cockpit somewhere, and the
terminal's questions and permission prompts are taken out of the TUI and held
for them there. It started in Claude Code's default permission mode, which asks
before each write and each command.

That mode assumes someone at the keyboard. What is actually started in these
sessions is a `/gate:run` — a pipeline whose nodes read this project, write to
a worktree and run its test command, dozens of actions deep. Every one of them
arrived in Approvals as its own row, and the run stood still between them. A
run left alone for ten minutes had moved one node; the person came back to a
queue of approvals for work they had already asked for by starting the run.

## Decision

Every session gate starts for a person begins in auto mode:
`--permission-mode auto` on the server's spawn, and the same flag on the
cockpit's, so a session is the same thing whichever host it runs on. The
cockpit still holds what auto mode will not decide, and Shift+Tab in the
terminal changes the mode for that session.

## Rationale

Auto mode is the mode this work is shaped like: a classifier decides the
ordinary actions and escalates the ones with consequence. The person keeps the
decisions that are genuinely theirs — the node that asks what they want, the
plan they approve, the action auto mode refuses to take on its own — and loses
the ones they were only rubber-stamping.

It is also what a run already is elsewhere. A node that runs on the server as a
headless worker has used `--permission-mode auto` since it existed; a node the
session itself does was the same work under a stricter mode purely because of
where it happened to run. One mode for both makes a run cost the same wherever
it is driven.

Not `bypassPermissions`: Claude Code refuses it when the process is root, which
is how a gate runs as a service, and it refuses for a good reason — that mode
as root is unrestricted execution on the host. Auto mode keeps a judgement in
the loop and keeps the escalation path to the person.

## Alternatives

Leave the default mode and let people press Shift+Tab. That is what happened,
and it is the wrong default for a terminal nobody is looking at: the prompt
that would tell them to switch is itself in the TUI they never see, and by the
time they notice, the run has been stopped for a while.

Set `permissions.defaultMode` in the settings file the child is given instead
of passing the flag. The same effect by a quieter route — the flag is at the
spawn, next to the other arguments a reader is already looking at, and a
settings file is merged with the person's own where the flag is not.

Auto-approve permission requests in the hub — answer `allow` to anything a
terminal asks. That is a permission model of our own, written next to Claude
Code's, and it would decide with less context than the classifier has while
looking to the person like they approved it.

## How it works

`RemoteManager.spawn` passes `--permission-mode auto` with `--settings` and
`--plugin-dir` for every session it starts, a fresh one and a `--resume` alike.
The hub is unchanged: `PermissionRequest` hooks still reach the gate process
and are still held for the person's cockpit — there are simply far fewer of
them, because auto mode settled the rest.

The cockpit passes the same flag on its own spawn (`spawnClaude`), so a session
on the desktop and a session on the gate start alike.

## Consequences

A run started from a cockpit now writes files and runs this project's commands
without asking first. That is what starting a run asks for, and it is the
change to be aware of: the safety of a run is its worktree and its branch, not
a prompt per action.

A person who wants the old behaviour presses Shift+Tab in the terminal, which
is per session and not remembered. Nothing in gate remembers a preferred mode;
if that is wanted, it is a setting and a later decision.

Auto mode needs a Claude Code that has it. Gate's own workers have required it
for longer than sessions have existed, so a server that can run a workflow can
run a session.

## Touches

- `src/remote/manager.ts`
- `docs/design/remote-sessions.md`
- `tests/remote.test.ts`
- the cockpit's `src/main/index.ts`

## Supersedes

none
