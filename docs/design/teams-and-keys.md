# Teams and keys

## Summary

A gate serves a small group of people through one endpoint. Each of them
holds a key that names them and the team they are on; the team owns a set of
agents, workflows and skills, and a key can only ever read its own team's.
Revoking a key, disabling a person, or moving them to another team takes
effect on the next request. A gate with one person and no teams keeps working
exactly as before, on the `default` team.

## How it works

`/team` is where a person becomes able to connect: add a team, add someone to
it, issue them a key. The key is shown once, and in two forms — the same login
by two roads, because one of them is closed exactly when it is needed:

```bash
/gate:login <token>                  # in Claude Code
~/.local/bin/gate login <token>      # in a terminal, Claude Code closed
```

**Connecting never needs a model turn.** The slash command is a prompt, so it
costs one; a Claude Code whose account is at its weekly limit runs no prompt at
all, and the person it refuses is precisely the person trying to get onto a
gateway that would serve them on the team's quota instead. So the plugin writes
`~/.local/bin/gate` itself, from its SessionStart hook, on every ordinary
session — ahead of the emergency, and pointing at the bundle that session
loaded, so a plugin update moves it. The terminal line names the shim by
absolute path and therefore does not care whether `~/.local/bin` is on anyone's
PATH. Logging in itself contacts only the gate: the team, the definitions, and
one optional read of the model list that falls back to a built-in list when the
account behind it is spent. A rate limit can no more block a login than it can
block the dashboard.

Logging in again keeps what this machine had decided — the workflow versions
its owner approved to run here, and where their own clone of each connected
repository is. Connecting to a *different* gate drops both, since an approval
is recorded against a definition hash that gate issued and a repository id
means nothing to a gate that never resolved it.

Only the SHA-256 hash of the key is stored; the plaintext is not recoverable
afterwards. A **team** is a slug (`[a-z0-9-]`, up to 64 characters), not a
UUID, because it is a directory name a person reads and edits: the team's
definitions live in `~/.gate/teams/<team>/agents/*.md`, `.../workflows/*.yaml`
and `.../skills/<id>/SKILL.md`, hand-editable files. Teams, people and keys
themselves live in SQLite. A team may sit under another team; the tree is
what memory search is scoped to, and a team with teams under it cannot be
deleted until they are moved or deleted.

A **person** has one team and one or more keys. Moving them to another team
moves their keys with them, so no key is left pointed at definitions its
owner can no longer see; disabling them makes every key they hold stop
resolving, without anyone remembering which keys those were; deleting them
revokes the lot. Deleting a team takes its people and keys with it but leaves
its definition directory alone — the files are the deliverable of whoever
wrote them.

Everything that existed before teams belongs to `default`. An install that
had `~/.gate/agents` and `~/.gate/workflows` has them renamed under
`~/.gate/teams/default/` on first read — renamed rather than copied, because
two directories holding the same agents with one silently ignored is worse
than either — and a single-person gate keeps working with nothing to do. The
default team is also the house library: a team's scope falls back to the
default team's definitions for any name it has not written itself, its own
copy always wins, and nothing can write into the fallback, so "whose is this"
has one answer. Keys issued before there were people carry no owner and read
as the default team's.

Keys carry **scopes**: `gateway` (model calls), `workflows` (pull definitions,
report runs), `author` (write them) and `remote` (run sessions on this
server). A new key gets `gateway` and `workflows` unless the person issuing it
says otherwise; a key for a third-party tool can be issued `gateway` only.
`author` and `remote` are off by default and ticked deliberately when the key
is issued: reading a team's definitions is what everyone on it needs, writing
them is a decision about that team's pipelines, and a terminal on the gate's
own machine is a decision about that machine. A key issued before scopes
existed reads as an ordinary one — everything it could do then, nothing added
since. A key with no scope at all is inert.

Two surfaces verify keys, and they differ on purpose:

- The **gateway** (`/api/gateway/*`) takes an issued key with the `gateway`
  scope when any key exists, else `GATE_API_KEY`, else — when neither is
  configured — is open, which is what a loopback-only install has always
  been. Without a person attached it answers as the default team.
- The **client API** (`/api/v1/*`) — what the `gate` CLI on a developer's
  machine talks to — is **never open**. It hands out a team's definitions and
  accepts run reports, so an unauthenticated caller there would be handed
  every workflow the team has written. It refuses a client older than the
  minimum version first, with the command that fixes it (`426
  CLIENT_TOO_OLD`); then a missing key (`401 NO_API_KEY`), a key without
  `workflows` (`403 SCOPE_MISSING`), a key whose team no longer exists
  (`403 TEAM_GONE`), and an unknown or revoked key (`401 INVALID_API_KEY`).
  `GATE_API_KEY` still works there, as the default team with `gateway` and
  `workflows`.

Resolving a key is one statement that does the lookup and the liveness check
together — a revoked key and an unknown one are the same answer — and touches
`last_used_at` and the reporting host (`x-gate-host`), so the dashboard's
"last used" column is true for every surface a key can reach.

A run is visible to the team whose workflow produced it. Two people on the
same team can watch each other's runs; only the run's owner can report steps
into it.

### Which team a definition belongs to

Every agent, workflow and skill belongs to exactly one team — that is what
makes "this team's workflows" a set anyone can reason about, and what a key
resolves to when a client pulls. `/agents` and `/workflows` carry a team
switcher when there is more than one team, and the choice rides in the URL
(`?team=<id>`), so a link to another team's pipeline is a link rather than a
screenshot. An unknown or malformed team in the URL falls back to `default`
rather than 404ing, so a stale dashboard tab cannot wedge the editor.

Assigning one elsewhere is therefore a **move**, offered on the same selection
bar that deletes: tick the rows, pick a team. A workflow is written into the
destination through the same validation a hand-edited file gets, so one whose
agents are still behind is refused there — with that reason — and stays where
it works, rather than landing broken and disappearing from where it ran. Move
the agents first; the confirmation says so. A definition that no longer
parses — usually because the agents it names went somewhere else — is
selectable in the error card for exactly this reason: it is the one you most
need to move or delete, and listing it while making it untouchable is how a
workflow becomes unreachable from the page that owns it. An agent that leaves
workflows behind naming it is not refused, because it is your file and
deleting one has never been refused either, but the workflows that will stop
loading are named.

## Key files

- `src/lib/teams.ts` — teams (slug ids, parent tree, `teamFamily`), people, the key-follows-owner rule on move, revoke-on-delete
- `src/lib/apikeys.ts` — key issue and hashing, scopes and their defaults, `resolveKey` (lookup, liveness, disabled-owner check, last-used touch)
- `src/lib/gate-auth.ts` — `gatePrincipal`: the gateway's issued-key / env-key / open rule
- `src/lib/tenancy.ts` — `requireClient` for `/api/v1/*` with its error codes, `scopeForPrincipal`, `ownsExecution`
- `src/lib/def-root.ts` — `DefinitionScope`: a team's root, its fallback to the default team, `ownScope`, the one-time legacy rename, `scopeFromRequest` for `?team=`
- `src/agents/registry.ts`, `src/workflows/registry.ts`, `src/skills/registry.ts` — the file stores, each taking a scope rather than knowing a path
- `src/middleware.ts` — the admin cookie that guards the dashboard and `/api/*` management routes, a separate concern from keys
- `src/lib/protocol.ts` — the lines a key is handed out as: `installLines` for Claude Code, `terminalLoginLine` and `bundleLoginLine` for a terminal
- `plugins/gate/scripts/session-start.mjs` — the SessionStart hook: writes `~/.local/bin/gate` pointing at the bundle beside it, and only when it would change
- `src/client/cli.ts` — `cmdLogin`, and `cmdInstall`, the by-hand writer of the same shim
- `src/client/config.ts` — `writeLogin`: a login that keeps this machine's approvals and repo paths on the same gate, and drops them on a different one

## Pitfalls

- A gateway with no issued keys and no `GATE_API_KEY` is open. Issuing the first key closes it for everyone, including tools that were working keyless.
- The client API never falls back to open. A developer's `gate login` against a keyless gate needs `GATE_API_KEY` at minimum.
- Scopes are checked per surface: a `gateway`-only key is refused by `/api/v1/*` with `SCOPE_MISSING`, and a `workflows` key with no `gateway` scope cannot make model calls.
- Moving a person moves their keys; issuing a key to a person on team A and then moving the person to team B means the key now reads team B's definitions. That is the intended rule, but it surprises a tool that cached team A's.
- The fallback to the default team is read-only. A team that edits an inherited agent gets its own copy; the default team's file is untouched and other teams still see it.
- Deleting a team does not delete `~/.gate/teams/<team>/`. Re-creating the same slug picks the old files back up.
- The legacy rename runs once per process per `GATE_HOME`; a rename that fails (permissions, a mount boundary) leaves the old directory in place and the team starts empty and seeded.
- The shim is written by a session, so a machine that installed the plugin and never restarted Claude Code has none yet. The dashboard names the bundle path as well for exactly that machine, and `gate install` writes it by hand.
- `~/.local/bin` that cannot be written leaves no shim and says nothing: a session start is not failed over a convenience. The bundle is still reachable by its own path.

## Decisions

- [0011 — Three auth surfaces, three rules](../decisions/0011-three-auth-surfaces-three-rules.md)
- [0026 — Connecting a machine never needs a model turn](../decisions/0026-connecting-never-needs-a-model-turn.md)
