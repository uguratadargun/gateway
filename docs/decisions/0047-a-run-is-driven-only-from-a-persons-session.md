# 0047. A run is driven only from a person's own Claude Code session

Status: accepted
Date: 2026-09-24
Run: manual

## Context

A workflow could run in five places. The server ran it, started from the dashboard or resumed there, with gate's own agent loop for the small nodes and a spawned Claude Code for the large ones. A remote session was a Claude Code in a terminal on the server, driven from a desktop cockpit. The Telegram bot started runs and answered their questions from a chat. `gate run` ran a workflow headlessly on a laptop, with the same loop the server used. `/gate:run` drove one from the person's own session, one node at a time. There, a large node became either a subagent of the session or a detached worker the session followed with `gate wait`.

Every one of those but the last needs a model the server or the CLI can call itself. With no Claude login on the gate (0046), none of them has one.

## Decision

A run is driven from a person's own Claude Code session and nowhere else. `/gate:run` (`gate begin`, `next`, `step`, `continue`) is the only driver. The server runner, starting and resuming runs from the dashboard, remote sessions, the Telegram bot, headless `gate run`, the detached worker with `gate wait`, gate's own agent loop and the spawned-Claude-Code executor are gone.

Within a run, an `executor: gate` node is done by the session itself, and an `executor: claude-code` node is always a subagent of the session in the agent's own model. The dashboard shows, stops and forgets runs. It says which command restarts or continues one, on the machine it ran on.

Work in flight stays part of recall (0039). The Telegram message it also sent when two teams started the same work is gone with the bot.

## Rationale

The session is the one place that has a model the person is entitled to use, and it was already where runs happened. Everything else existed so that a run could go on without the person's session: overnight on the server, from a phone, from a script. Each of those needed a login that was not the person's.

With one driver there is one walk (`nextInSession`), one way to hand a node to a model, and one place the person can answer a question. Gate's own loop, with its tool implementations, its context clearing (0045) and its output retries, was a second implementation of what Claude Code already does, and it was only reachable from drivers that no longer exist.

## Alternatives

**Keep the headless drivers on a provider model.** The server's vLLM could run dashboard-started runs, and `gate run` could run on it too. A planner or an implementer on a local model is a much weaker pipeline than the same one on the person's Claude, and a run whose quality depends on where it was started is hard to reason about.

**Run the gate-executor nodes of a headless run as `claude -p` workers on the person's login.** Terminal and CI runs would survive, at the cost of keeping the worker, the executor and a second walk alive for a use nobody on the team has.

**Keep remote sessions with the person's own login on the server.** The server would hold each person's credential for as long as their session lives. That is the pool again, one login at a time.

## How it works

`gate next` hands the session one of four instructions: do this node yourself (`agent`), start this subagent (`delegate`), the run is over (`done`), or it failed or was stopped. A `claude-code` node is always `delegate`: the subagent file under `~/.claude/agents/` carries the agent's model. Its answer comes back through `gate step`, like a node the session did itself, and a node's next pass continues the same subagent.

The server takes runs only as reports on the client API. Stopping a session-driven run from the dashboard settles it at once. The execution page shows `gate continue <id>` for a failed run and `/gate:run <workflow>` otherwise, with the host it ran on. A workflow's page says how to start it.

## Consequences

Nothing runs while nobody is at a keyboard, apart from the recorder and the record index. A long pipeline needs the person's session open for its length, and a laptop that sleeps stops it; `gate continue` picks it up at the failed node.

A run cannot be started from the dashboard, from a phone or from CI.

A node's cost is not reported: the session and its subagents are the person's own Claude Code, and nothing on the gate sees their usage.

A person with the old plugin is refused by the gate until they update, because their CLI would start a worker pointed at a gateway that is not there.

## Touches

- `src/client/step.ts`
- `src/client/cli.ts`
- `src/client/subagents.ts`
- `src/runtime/executors/agent.ts`
- `src/agents/tools.ts`
- `src/skills/inject.ts`
- `src/app/api/executions/[id]/cancel/route.ts`
- `src/app/executions/[id]/page.tsx`
- `src/app/workflows/[id]/page.tsx`
- `src/memory/activity.ts`
- `plugins/gate/commands/run.md`
- `plugins/gate/reference/authoring.md`
- `docs/design/dev-workflow.md`
- `docs/design/executions.md`
- `docs/design/workflows-engine.md`
- `docs/design/workspaces.md`

## Supersedes

0022: no session is started on the server.
0023: no run calls a gateway, so none needs a token for one.
0039 in part: work in flight is still in recall; the Telegram push is gone.
0045: gate has no agent loop of its own.
