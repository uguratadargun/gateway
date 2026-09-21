Status: done
Branch: pipeline/record-only-and-subagent-addressing
Decisions: docs/decisions/0026-connecting-never-needs-a-model-turn.md
Design: docs/design/teams-and-keys.md (how a key is handed out, and what a
re-login keeps)

# A machine connects to the gate without Claude Code

## Goal

Teammates could not connect. Their personal Claude account had spent its weekly
limit, so Claude Code refused every prompt — and `/gate:login` is a slash
command, which is a prompt, which is a model turn. The command that would have
put them on the team's gateway, served by the pool's quota instead of their own,
was behind the account that was out of quota.

What was asked: fix it, so they can log in.

Two readings were ruled out by measurement before anything was written.

- **The gateway was not out of quota.** The live gate at `10.0.80.35:4141` had
  three accounts, two available, one cooling down, 87% left on its weekly
  window, at the moment nobody could reach it.
- **Login does not spend a model call.** Tracing `cmdLogin`: `/api/v1/me` and
  `/api/v1/bundle` are local reads; the one upstream call
  (`/api/gateway/v1/models` → `api.anthropic.com/v1/models`) falls back to a
  built-in list on any failure and is caught client-side anyway. A login has
  never been possible to fail on a rate limit — only to be prevented from being
  typed.

The user then established the decisive fact: a `!`-prefixed Bash line pasted
into Claude Code hit the weekly limit too. A Claude Code at its limit accepts no
input at all, so **no path inside Claude Code is a way out of it** — which also
killed the `UserPromptSubmit` hook that would otherwise have been the neat fix.

Out of scope: the account pool, the gateway's 429, and a `curl | sh` bootstrap
for a machine with no plugin (recorded as deferred in 0026).

## Approach

The plugin puts a real command on the machine, ahead of the emergency. The
SessionStart hook already runs on every session; it now also writes
`~/.local/bin/gate` — a shim pointing at the bundle beside it — whenever that
file's contents would change, silently doing nothing when it cannot. By the time
anyone is rate-limited, the terminal already has a `gate`.

The dashboard hands a key out as two lines instead of one: the slash command for
a working Claude Code, and `~/.local/bin/gate login <token>` for a terminal with
Claude Code closed, with one sentence saying which is which and that connecting
spends no model call. Both come from `src/lib/protocol.ts`, so the dashboard, the
command doc and the design doc cannot drift apart. A third form names the
versioned bundle path, for a machine that has the plugin but has not restarted
since installing it.

Found while tracing, fixed here because this change tells people to log in
again: `cmdLogin` wrote a fresh `client.json` and silently dropped `trusted`
(workflow approvals) and `repos` (local checkout paths). `writeLogin` keeps both
when the gate url is unchanged, and drops them when it is a different gate.

## Done when

- The SessionStart hook writes an executable `~/.local/bin/gate` pointing at the
  sibling bundle; a second session does not rewrite it; a shim pointing
  elsewhere is replaced. — `tests/session-start-shim.test.ts`
- Re-logging into the same gate keeps `trusted` and `repos`; logging into a
  different gate drops them. — `tests/client-config.test.ts`
- The Team page shows the terminal line, with a copy button, beside the slash
  command, and names the bundle fallback.
- `~/.local/bin/gate usage` answers against the live gate from a plain shell,
  with Claude Code closed.
- `npm test`, `npm run typecheck`, `npm run build:cli` pass, at 0.41.0 in
  `plugin.json`, `marketplace.json` and `GATE_VERSION`.

## What shipped

All of the above. The record: decision 0026, `docs/design/teams-and-keys.md`
rewritten at the connect section (plus key files and two pitfalls), this spec,
and one `CHANGELOG.md` line under Unreleased.

Left for later: a machine that installed the plugin and never restarted Claude
Code still has no shim, and the dashboard's bundle-path line is what covers it.
The `curl -fsSL <gate>/install | sh` bootstrap that would close that gap is
deferred in 0026.
