# 0046. Every person runs on their own Claude login; gate holds no model credentials and serves no models

Status: accepted
Date: 2026-09-24
Run: manual

## Context

gate began as a gateway. People connected their Claude Code OAuth logins to it, and every person on the team pointed their Claude Code at it. The gate kept those logins in a pool, rotated between them as each one's rate-limit window filled, and served everyone's model calls from whichever login still had room. Everything else grew around that gateway: model routing, a response cache, prompt compression, a concurrency limiter, a budget, a traffic log, per-account quota bars, a playground, and support for Cursor and OpenAI-dialect clients. `gate login` put every one of a person's Claude Code sessions on it.

Pooling subscription logins and serving them to other people is the part that cannot stay. A Claude subscription belongs to the person who holds it. A gate that holds several and hands their capacity to a team is account sharing, however small the team. The rest of gate does not depend on it: a run's definitions, its record, the memory and the cross-team work all live on the gate, while the model calls were only routed through it.

## Decision

gate holds no Claude login and serves no models. Each person's Claude Code runs on that person's own login, on their own machine, and every model call a run makes is theirs. The account pool, the gateway endpoints and everything that existed only to serve them are gone: routing, the cache, compression, the limiter, the budget, the usage and traffic logs, the quota windows, the playground and the client configuration pages.

The gate is a control plane. It holds the team's definitions, takes the reports of runs, keeps the memory and the record index, and answers the client API. It has two auth surfaces: the admin session for the dashboard and the management API, and issued keys for the client API. A key's scopes are `workflows` and `author`; a key issued with `gateway` or `remote` keeps only the scopes that still reach something.

The server still makes one kind of model call of its own: the memory recorder and consolidation read a finished run and write what it decided. They go directly to a configured provider (a vLLM on the gate's own network, or a hosted endpoint), named in Settings as `provider:<name>/<model>`. Until a provider model is named, finished runs wait in the ledger and the dashboard says why. A provider model's work is recorded as costing nothing, because it is on nobody's Anthropic bill.

An agent's `model:` is a Claude model: an alias or a `claude-*` id. A `provider:` reference is refused when the agent is saved, because nothing on the person's machine can reach it.

## Rationale

The pool was the one thing gate did that it should not do, and every alternative that kept a pool kept that problem. Taking it out also takes out the reason for the gateway. A gateway that serves only provider models to the few tools that want them is a second product the team does not use.

Moving the model calls to the person's own Claude Code costs gate almost nothing. A run was already driven by the person's session, one node at a time. The session did the gate-executor nodes itself. The `claude-code` nodes were subagents of the session whenever the session was on the gateway. Off the gateway, a subagent's model is a name the person's own Claude Code resolves.

The recorder has to run on the server. It runs after a run ends, when the person's session may be gone, and it reads every team's runs into one memory. A provider model on the gate's own network does that without holding anyone's subscription. The model already serves the embeddings. The recorder's work is short, structured and not urgent, so a smaller model is enough.

## Alternatives

**Pass the person's own OAuth token through the gateway.** Claude Code would send its own login to the gate, which would forward it upstream and keep routing, caching and the traffic log. The gate would then hold every person's live credential in transit, and use it for requests Claude Code did not shape. That is the same problem in a different place.

**Keep the gateway for provider models only.** Cursor, the playground and a provider-backed tier would keep working. Nobody on the team uses them for work, and the gateway would keep its whole pipeline for a use case with no user.

**Keep one service login on the server for the recorder and for `ask`.** That is a pool of one, shared by everyone whose runs it reads.

**Move the recorder to the person's machine.** Their Claude would record the run as it ends. A run stopped from the dashboard, or one whose laptop closed, would never be recorded, and consolidation, which reads across runs, would have no machine to run on.

## How it works

`gate login` connects the machine and writes the team's subagents. It no longer touches Claude Code's settings, except to remove what an older `gate login` put there. The plugin's SessionStart hook does the same removal on every session: a base URL ending in the gateway's path, a credential that is a gate key, the two variables and the setting only the gateway wanted, and the provider rows in the model picker. It then tells the person to restart Claude Code once.

A `claude-code` node is always a subagent of the session, started from the file gate keeps under `~/.claude/agents/`, in the agent's own model.

On the server, the database drops the accounts, their rate-limit history, the usage and traffic logs, the response cache and the gateway's session titles on its first open. The sealed tokens go with the accounts table. A settings file from before keeps loading. Its gateway sections are read past, and a recorder model that is not a provider reference reads as no model.

## Consequences

A person's Claude Code shows their own plan's usage with `/usage` again, and what a run costs is on their own plan. The execution page no longer says what a new run cost: every agent node is done by the session or its subagent, and neither reports usage. Runs recorded before keep the figures they have.

There is no server-side budget, throttle, cache or traffic log for runs, and no per-person usage report on the dashboard. A limit on what a person spends is their plan's.

A tool that pointed at the gateway (Cursor, a script, the playground) stops working, and nothing replaces it.

The old CLI is refused, because it would put nodes on a gateway that is not there. The minimum client version moves to this release.

The recorder records nothing until an administrator names a provider model. A deployment that forgets to do so keeps every run waiting in the ledger rather than recording it on something else.

## Touches

- `src/lib/settings.ts`
- `src/lib/db.ts`
- `src/lib/apikeys.ts`
- `src/lib/tenancy.ts`
- `src/middleware.ts`
- `src/providers/direct-provider.ts`
- `src/memory/queue.ts`
- `src/agents/types.ts`
- `src/client/claude-settings.ts`
- `src/client/cli.ts`
- `src/client/step.ts`
- `plugins/gate/scripts/session-start.mjs`
- `src/app/page.tsx`
- `docs/ARCHITECTURE.md`
- `docs/design/providers.md`
- `docs/design/memory.md`
- `docs/design/teams-and-keys.md`
- `docs/design/dashboard.md`

## Supersedes

0011 in part: there are two auth surfaces now, and the gateway's is gone. The admin session and the client API keep their rules.
0015: nothing resolves model names any more.
0017: there is no traffic log.
0019: there are no accounts to park.
0020: there is no gateway to put in the picker.
0034: there is no traffic row.
