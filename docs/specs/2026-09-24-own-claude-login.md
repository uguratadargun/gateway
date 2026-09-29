Status: done
Branch: feat/own-claude-login
Decisions: docs/decisions/0046-every-person-runs-on-their-own-claude-login.md, docs/decisions/0047-a-run-is-driven-only-from-a-persons-session.md, docs/decisions/0048-ask-is-read-on-the-askers-machine.md, docs/decisions/0051-a-run-warns-at-its-start-about-what-its-end-needs.md
Design: docs/ARCHITECTURE.md, docs/design/providers.md, docs/design/memory.md, docs/design/teams-and-keys.md, docs/design/dashboard.md, docs/design/dev-workflow.md, docs/design/executions.md, docs/design/workflows-engine.md, docs/design/workspaces.md, docs/design/cross-team.md, docs/design/repositories.md, docs/design/agents-and-skills.md, docs/design/the-record.md; removed: account-pool, gateway-pipeline, routing, remote-sessions and telegram

# Every person on their own Claude login

## What was asked

Remove account pooling entirely. Nobody's Claude login lives on the gate any
more. Everyone works with the Claude account on their own machine, and the
system otherwise works as it did: `/gate:run` still runs the team's pipelines,
and memory, cross-team questions and the dashboard still do their jobs.

The person settled four questions along the way:

- The server's own AI work (the memory recorder and consolidation) runs on a
  local LLM on the gate's machine, a provider model.
- `ask`, which reads another team's code, runs on the asker's machine.
- The gateway goes entirely, not just the pool.
- Starting runs on the server goes, and so do remote sessions, the Telegram
  bot and headless `gate run`.

Nothing is pushed until the person has talked it through.

## What counted as done

- No Claude credential, pool, OAuth login or gateway endpoint is left on the
  server. The database drops the accounts and the gateway's logs on its first
  open, and revokes the keys minted for Telegram links.
- A `claude-code` node is always a subagent of the session, on the person's
  own login. There is no worker and no `gate wait`, and no code path points a
  Claude Code at the gate.
- `gate login`, `gate reset` and the plugin's SessionStart hook take gate's old
  gateway wiring out of Claude Code's settings, and leave everything else in
  them alone.
- The recorder and consolidation run on a `provider:` model named in Settings.
  With none named, runs wait in the ledger and the reason is shown.
- An agent naming a provider model is refused on save.
- `gate ask` starts an `ask` run in the asker's session. The run reads the
  commit the gate fixed through read-only routes that check the team, the
  expiry and the family on every read.
- The server runner, remote sessions, Telegram, headless `gate run`, gate's own
  agent loop and the spawned-Claude-Code executor are deleted, with their
  pages, routes and tests.
- The shipped pipelines' routing tests run through the session walk
  (`nextInSession`) instead of the deleted engine, and all pass.
- `npm run typecheck`, `npm test` (with `docs:check`), `npm run build` and
  `npm run build:cli` pass. The three version numbers are 0.47.0, and the
  minimum client version is 0.47.0.
- The record says all of this in the present tense: three decisions, the
  superseded ones marked, the design docs rewritten or removed, the map, the
  README and the changelog.

## The follow-up (0.49.0)

Asked after it shipped: what a person has to set up on their own machine now
that every run happens there, which model an agent runs on and how it is
chosen, and what the removal left behind. Done when:

- An agent's `effort` reaches Claude Code: the subagent file carries it next to
  `model`, and an agent with none (or `default`) leaves it to the session.
- A GitHub run on a machine whose `gh` is not signed in says so at `gate begin`,
  and `/gate:run` passes it on; it warns and does not refuse.
- The README, `/gate:login` and the Team page say what each machine needs:
  its own Claude login, git access that can push, `gh` or `glab` for the merge
  request, and `gate repo` for a connected repository.
- The editor's model list names the current Sonnet.
- What the removal left behind is gone or says what is true: unused components
  and client modules, dead exports, the provider layer's streaming and tool
  calling, the `tool.called` event and its card, the resume seed, the ceilings
  shown and advertised as if enforced, a client that could still start an
  "engine" run, and comments naming the engine, the worker, the account's
  quota window or server-side runs.
- `npm run typecheck` and `npm test` pass; the three versions are 0.49.0.

## Not done here

- Deploying to the live gate. That means a pull and build, then naming the
  recorder's provider model and restoring the shipped `ask` workflow for teams
  that keep their own copy.
- Reporting what a node cost. The session and its subagents are the person's
  own Claude Code, and nothing on the gate sees their usage.
