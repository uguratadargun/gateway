# 0028. A subagent is addressed by its agent id, and nothing else is accepted

Status: accepted
Date: 2026-09-21

## Context

A `delegate` node is run as a subagent of the session driving the run, and a
node's next pass is meant to continue that same subagent: it still holds the
plan it read, the files it opened and what it decided. `gate step --subagent`
is how the run records which subagent to continue, and `resume` in the next
instruction is how it is handed back.

Three places described what to pass, and all three said "the agent id or name":
`src/client/step.ts`, `src/client/cli.ts`, and `plugins/gate/commands/run.md`.
There is no name that works. The Agent tool returns a short opaque id; the
`gate-<team>-<agent>` string is the *type* name of the mirror file in
`~/.claude/agents/`, and SendMessage to a type name resolves to nobody.

`--subagent` accepted whatever it was given and recorded it. So the run stored
a value that would never resume, the next pass started a fresh subagent, and
that subagent read the worktree from nothing. Measured on the 2026-09-21 run:
the verifier's tree read the plan file fourteen times and `src/client/cli.ts`
eleven times across passes that were supposed to be one conversation.

Nothing failed. The run got slower, and the only sign was in the transcripts.

## Decision

`gate step --subagent` refuses a value that begins with this team's subagent
prefix, with a message saying what the id is and where it came from. The
refusal happens before the node is recorded, so a rejected step leaves the run
exactly where it was.

The prose in all three places is corrected to say the agent id and to say
plainly that the type name is not it.

## Rationale

The prose had been correct-sounding and wrong for as long as it had existed,
and a fourth rewrite of it would have the same failure mode: the value is
written by a model, in the middle of a long run, from an instruction several
thousand tokens back. What stops a wrong value is refusing it.

The discriminator is exact rather than heuristic. A wrong value here is always
`subagentName(ctx.team, …)`, because that is the filename gate itself wrote and
told the session to start; nothing else is plausibly confused for an agent id.
So the guard tests for that prefix and leaves every other string alone,
including ids from tools that do not look like Claude Code's.

Refusing before `record()` is the part that matters. A guard after it would
leave a node recorded as run, with its output taken and its edges followed,
and a resume target pointing at nobody — the same failure as before, now with
an error message.

## Alternatives

**Accept the type name and resolve it.** There is nothing to resolve it
against: the mirror file names a type, and the running subagent that holds the
context is a different thing with a different handle.

**Accept it and silently drop it** — record no subagent rather than a bad one.
That is the current behaviour's outcome with none of its diagnosis: the run
would still read the worktree again every pass, and nobody would learn why.

**Warn and continue.** A warning in a run's output is read by nobody; the
value is wrong and the correct one is in the session's hands at that moment.

## How it works

`step()` in `src/client/step.ts` builds the prefix with
`subagentName(ctx.team, "")` and throws a `WORKFLOW_ROUTING_ERROR` when
`opts.subagent` starts with it. The message says the id is what the Agent
tool's result carried, that the type name spawns a fresh subagent which reads
the whole worktree again, and that handing the step back without `--subagent`
at all is better than handing it back wrong.

The `remember` lines the run prints now say `--subagent <its agent id>` and
carry a line saying the id is not the type name. `cli.ts`'s help and
`plugins/gate/commands/run.md` say the same.

## Consequences

A session that hands back the type name gets an error and the node is not
recorded: it fixes the argument and hands the same file back. A session that
has lost the id hands the step back without `--subagent`, which costs the next
pass a fresh read and nothing else.

A team on an older client is unaffected — the guard is client-side, and a
client that does not have it behaves as before.

This is a shipped permission taken away. Nothing was relying on it working,
because it never worked.

## Touches

- `src/client/step.ts`
- `src/client/cli.ts`
- `plugins/gate/commands/run.md`
- `tests/session-worker.test.ts`
- `docs/design/dev-workflow.md`

## Supersedes

none as a record. It reverses the licence given by the sentence "its agent id
or name" in `plugins/gate/commands/run.md` and `docs/design/dev-workflow.md`,
both of which are corrected rather than left standing.
