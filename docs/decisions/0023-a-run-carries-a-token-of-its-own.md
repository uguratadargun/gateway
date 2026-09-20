# 0023. A run carries a token of its own

Status: accepted
Date: 2026-09-20
Run: gate/run-525fd5c1

## Context

gate's own children have to get through gate's own front door. A node whose agent uses the `claude-code` executor is not run by gate's loop at all: gate spawns a headless Claude Code in the run's worktree and points it back at gate's gateway, so that everything the child spends is routed, metered and counted against the run exactly like a call gate made itself. That child is an ordinary gateway client, and the gateway's admission rule (0011) knows only three kinds of caller: an issued key carrying the `gateway` scope where any key has been issued, the `GATE_API_KEY` environment variable where that is configured, and — where neither is — nobody in particular.

The child was given none of them, on the premise that a gateway reached over loopback needs no credential. That premise was never true: the admission rule looks at the token and not at the source address, so the first gate to issue a key to anybody turned every one of its own runs into an unauthenticated caller. What it looked like from outside was a node failing on its first request with nothing spent and nothing said — the child's own "Not logged in" stayed in the process logs, and the run reported only that claude-code had not finished.

The public address made it doubly wrong. The child was sent out by the address a person's browser uses, through the reverse proxy in front of the server, and back into the very process that had spawned it — so a request from a process to itself crossed the network and the proxy's timeouts.

Run traffic also has an identity to keep. Decision 0017 made the traffic log name who called and whose quota was spent, and gate's own in-process calls already answer under a sentinel key with the run's person and team. A credential invented for the child had to land in the same place, or a node's spend would have gone to a different caller than the same run's in-process spend.

## Decision

A run carries a token of its own. It is minted when the run starts, resolves to that run's own person and team, is dropped when the run ends however it ends, and is never written down. The gateway resolves it before it considers issued keys or the configured environment key, because it is neither of those and both of those would refuse it.

It is a credential for the gateway and for nothing else: it carries the `gateway` scope alone, and the surfaces a person's key reaches remain out of its range.

## Rationale

The run is the right thing to attach a credential to, because the run is the thing that has a beginning and an end. Anything the run spawns is alive between those two moments and dead outside them, so a credential with exactly that lifetime needs no expiry policy, no revocation and no cleanup pass: the code that starts a run is the code that ends it, and the token goes with it.

Keeping the token out of storage is what makes that lifetime real rather than intended. A credential in a table outlives the process that made it, and then somebody has to sweep. A credential in memory cannot: a restart invalidates every token there is, and a run whose gate restarted under it has already lost more than its token.

Resolving the token before anything else is the only order that works, not a preference. A run token is not an issued key, so on a gate that has issued any it would be refused by the rule that requires one; where the environment key is configured it would fail the equality. It has to be answered before either of those is asked.

Giving the token the run's own person and team, rather than an identity of its own, keeps one run's spend in one place. A node handed to a child and a node gate holds itself are the same run doing the same work for the same person; they should not read as two callers in the log, and with this they do not.

The narrow scope costs nothing and buys the boundary. A run has no business reading a team's definitions or authoring anything, and the gateway is the whole of what it needs.

Loopback is where a child's traffic belongs for reasons that have nothing to do with authentication: the child and the gateway are the same machine. Going out by the public address and back in adds a proxy to the path of a stream that may run for an hour, which is a buffering limit and an idle timeout that the call has no reason to be exposed to.

## Alternatives

Trust loopback inside the gateway: admit any request arriving from the local address as the local caller. It is the smallest change and it is the wrong boundary, because it grants admission by network position to everything on the host rather than to the run gate itself started — every other process on that machine included, on a machine that also runs whatever the workflows check out and execute. It would also still leave the call nameless: a request admitted for being local belongs to no run, no person and no team, and the traffic log would be back where 0017 found it.

An operator-configured second key in the environment, a `GATE_SELF_KEY` that gate hands to its own children. It is a long-lived shared secret, and a long-lived shared secret is exactly what a per-run credential exists to avoid: it sits in a service's environment for as long as the service runs, it is the same for every run, and a run that leaks it leaks it for all of them. It also makes a working gate depend on an operator remembering a step, which is the class of failure this started as.

Issuing a real key row per run, with a revocation at the end. It reuses the machinery that already exists, and in exchange every run writes and deletes a credential in the database, a crash leaves a live key behind with nobody to revoke it, and the list of a team's keys — a thing a person reads — fills with entries that are not anybody's. A sweep for orphans would then be needed, which is a second mechanism to maintain in place of the lifetime that was already free.

A wall-clock expiry on the token, as an issued key might have. A run has no fixed length, and any clock short enough to be worth having is short enough to kill a long node in the middle of its work. The run's own end is the only correct expiry.

## How it works

A registry holds, for the life of the process, the tokens of the runs that are currently going, each against the identity it answers as. Minting happens at exactly one place — where the server begins a run — and the token exists before the run takes its first step, because a node may reach the gateway immediately. Dropping happens in the same place, on every way out: a finished run, a failed run and a crashed run all drop it, and a second mint for the same run replaces the first rather than leaving it behind.

The identity in the registry is read from the run's own row: its person where the run has one, its team either way, under the sentinel key id that gate's own calls already use. A run started from the dashboard has no person recorded — there is one administrator there, and no per-person session to attribute to — so its calls read as the workflow caller with the run's team, which is what such a run has always read as.

The gateway asks the registry first. A token it knows answers as that run; a token it does not know changes nothing, and the request goes on to be judged by the rules that were already there. So a gate with no keys issued behaves exactly as it did, and a developer's machine — where the run is driven by the CLI, which passes that person's own key and their server's address — is untouched, because that credential arrives by a different route and is still the one used.

The child is pointed at the gateway of the process that spawned it, over the loopback address and the port that process is listening on. The address a person's cockpit reaches the server by is a separate question with a separate answer, and remains so.

Separately, a failed child now reports its own account of why it stopped: what it said in its result where it said anything, otherwise what it printed, truncated. The shape of a failure and its cause are different facts, and a person reading a failed run needs the second one.

## Consequences

Every run on the server can reach its own gateway, whatever keys that gate has issued, and what a node's child spends is filed against the run's person and team rather than against nobody.

A restart invalidates the token of every run in flight. This is the design and not a defect, but it means a run that survives a restart in any future sense would need its token minted again; nothing today does.

There is no expiry other than the run's end, so a run that never settles holds a valid token for as long as the process lives. The run being in flight is the same condition as its token being live, which is the property that makes this safe, and anything that changes how a run settles has to keep that true.

A run with no person recorded reads as the workflow caller in the traffic log, with its own team. Giving such runs an owner is a separate change to how a run is started, not to how it authenticates.

The token reaches the gateway and nothing else. A future surface that reads the same tokens by a different route would not inherit this boundary and would need its own record.

The child's traffic no longer passes the reverse proxy, so proxy access logs no longer see it. A gate whose gateway is reachable only through the proxy, and not on loopback, would break this — which is not how gate runs.

## Touches

- `src/lib/run-tokens.ts`
- `src/lib/gate-auth.ts`
- `src/executions/runner.ts`
- `src/runtime/executors/claude-code.ts`
- auth
- gateway
- executions

## Supersedes

none
