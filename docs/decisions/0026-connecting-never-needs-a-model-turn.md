# 0026. Connecting a machine never needs a model turn

Status: accepted
Date: 2026-09-21

## Context

A key was handed out as one line, `/gate:login <token>`, pasted into Claude
Code. A slash command is a markdown prompt, so running it is a model turn.

On 2026-09-21 that closed the door on the people it was built for. Teammates
whose personal Claude account had spent its weekly limit could not connect:
their Claude Code refused every prompt, and the command that would have moved
them onto the team's gateway — served by the pool's accounts, on the team's
quota — was itself a prompt. The one action a person needs when their model is
gone was the one action that required a model.

It is not a gateway failure and no amount of pool health fixes it. The live
gate had three accounts, two available and 87% left on its weekly window, at
the moment nobody could reach it. Nor does login itself need a model: `/api/v1/me`
and `/api/v1/bundle` are local reads on the server, and the single upstream call
(`/api/gateway/v1/models`) already falls back to a built-in model list on any
failure and is caught client-side. A rate limit has never been able to fail a
login — only to prevent one from being typed.

Running it as a Bash line inside Claude Code does not help either: a Claude
Code at its limit takes no input at all, so `!`-prefixed commands never run.
Nothing inside that process is a way out of it.

## Decision

Anything a person must be able to do when their model is unavailable is not a
slash command.

For connecting, that means the plugin puts a real command on the machine. The
SessionStart hook writes `~/.local/bin/gate`, a shim pointing at the bundle
shipped beside it, on every ordinary session — so it exists long before anyone
needs it — and the dashboard hands a key out as two lines rather than one: the
slash command for Claude Code, and `~/.local/bin/gate login <token>` for a
terminal with Claude Code closed.

Re-logging in is made safe at the same time, because this decision tells people
to do it: a login onto the same gate keeps that machine's workflow approvals
and repository paths, and only a login onto a different gate drops them.

## Rationale

The shim is written **ahead of the emergency**. A fix that has to be applied
while a person is rate-limited has to be reachable while they are rate-limited,
and nothing inside Claude Code is. Every ordinary session writing the file
costs one `readFileSync` and removes the problem for every future session.

**Absolute path, not PATH.** The line names `~/.local/bin/gate`, so whether
that directory is on anyone's PATH is not part of whether the fix works. Asking
a stuck person to edit their shell profile first is another door.

**Pointing at the loaded bundle** — `new URL("./gate.mjs", import.meta.url)` —
means a plugin update moves the shim on the next session, with no second
mechanism to keep the two in step, and no stale shim running a bundle the
server would refuse as too old.

**Two lines, not one replacing the other.** The slash command is still the
better road: it is one paste, it needs no path, and it is what a working Claude
Code should use. The terminal line is the road that stays open.

The approvals fix belongs here because the advice this record gives — connect
again, from a terminal — was, until now, a quiet way to lose the workflow
approvals that exist precisely so a workflow cannot run commands on a machine
without its owner having agreed.

## Alternatives

**A `UserPromptSubmit` hook that intercepts `gate login <token>` typed as a
prompt.** It can block a prompt before the model sees it, so it spends nothing,
and it would need no terminal at all. Rejected on evidence: a Claude Code at
its weekly limit does not accept the input in the first place, so the hook
never fires. It would have worked in every test except the one case it exists
for.

**Telling people the bundle's path and writing nothing.** It works — it is what
unblocked the team the day this was found — but it is a path with a version
number in it, sent over chat, retyped per machine, and stale after an update.
It is a workaround, and it remains in the dashboard only as the fallback for a
machine whose shim has not been written yet.

**`curl -fsSL <gate>/install | sh`, a bootstrap needing no plugin at all.** The
cleanest onboarding for a brand-new machine, and it removes Claude Code from
the first step entirely. Not rejected — deferred. It is a new public endpoint
that serves an executable script, which deserves its own decision, and it does
not help the machines that already have the plugin.

**Having `cmdLogin` install the shim.** Too late by one step: the first login
is the one that cannot run.

## How it works

On every session start the hook compares `~/.local/bin/gate` with the three
lines it would write and returns when they match; otherwise it creates the
directory and writes the shim `0755`. A failure of any of it — an unwritable
home, a read-only mount — is swallowed: a machine without the shim is a machine
that uses the bundle path, not a session that fails to start. `gate install`
writes the identical file by hand, for a machine holding the bundle without the
plugin, and the two writers are commented against each other.

The dashboard's Team page builds all of its lines from `src/lib/protocol.ts`, so
one file names the forms: `installLines` (Claude Code), `terminalLoginLine`
(the shim) and `bundleLoginLine` (the versioned bundle, for a machine that has
not restarted since installing).

`writeLogin` reads the config file before writing it and carries `trusted` and
`repos` across when the url matches, normalising the trailing slash on both
sides before comparing.

## Consequences

- A person can connect, or reconnect, with Claude Code closed and their account
  out of quota. The catch-22 is gone.
- The plugin writes a file outside its own directories, unasked, on every
  session. That is a real cost and the reason it is recorded here: it is bounded
  to one known path, it is idempotent, and it is silent when it cannot.
- A machine that has the plugin but has never restarted Claude Code still has no
  shim. The dashboard names the bundle path for it; this is the remaining gap,
  and the `curl | sh` bootstrap is what would close it.
- Re-logging in no longer silently revokes this machine's workflow approvals.
  Connecting to a different gate still drops them, which is a change in
  behaviour only for someone who moved gates and had approvals.

## Touches

- `plugins/gate/scripts/session-start.mjs`
- `src/lib/protocol.ts`
- `src/app/team/page.tsx`
- `src/client/config.ts`, `src/client/cli.ts`
- `plugins/gate/commands/login.md`
- `tests/session-start-shim.test.ts`, `tests/client-config.test.ts`
- `plugins/gate/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/lib/protocol.ts` (0.41.0)
- teams-and-keys

## Supersedes

none — no recorded decision covered how a machine connects. `docs/design/teams-and-keys.md`
described the single `/gate:login` line and is corrected by this record.
