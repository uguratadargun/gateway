# gate

Your team's development pipeline, run from Claude Code. A team keeps its
agents, workflows and skills on one gate; each person runs those pipelines
against their own repositories from their own Claude Code session, on their
own Claude login; and gate records what each run decided so the next run, in
any team of the tree, reads it before planning. Dashboard built with Next.js +
shadcn/ui.

> **Scope:** gate holds no Claude account and serves no models. Every model
> call a run makes is the person's own Claude Code. The gate holds the team's
> definitions, the runs, the memory and the cross-team record; every key names
> a person, belongs to a team, and can be revoked on its own.

## Where to get it

```bash
git clone https://github.com/uguratadargun/gateway.git
```

The repository is also a Claude Code **marketplace** carrying one plugin, `gate`
— `/gate:run` pulls your team's workflows and runs one **on your own machine**,
in a worktree of the repository you are in, on your own Claude login;
`/gate:design` designs one for that repository
([how a run works](docs/design/dev-workflow.md)):

```
/plugin marketplace add uguratadargun/gateway
/plugin install gate@gateway
```

A repository new to gate starts with `/gate:init`: it reads the code, writes
the map, a design doc per key part and the decisions the history shows, adds
`CLAUDE.md` and the rest of the skeleton, and can teach all of it to your
team's memory, so the first run plans knowing what was built before it.

## Setup

```bash
cp .env.example .env
# set GATE_SECRET (openssl rand -hex 32) and GATE_ADMIN_SECRET (openssl rand -hex 24)
npm install
npm run dev        # binds 127.0.0.1:4141; use `npm run dev:lan` to expose on your network
npm test           # vitest: the walk, the shipped pipelines, SQLite storage, memory
```

Open http://localhost:4141 and sign in with your admin secret. On the Team
page, add people and issue each a key: the key comes with the one
`/gate:login …` line they paste into Claude Code. The memory recorder is the
one thing the server asks a model itself: add a provider on the dashboard (a
vLLM or Ollama on your network, or a hosted endpoint) and name its model under
Settings → Memory as `provider:<name>/<model>`.

## Documentation

The repository keeps its own record, in four places, and the pipeline keeps
them true with the code ([the convention](plugins/gate/reference/docs.md)):

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the map: the parts, the
  boundaries, the invariants that hold everywhere. Start here.
- [`docs/design/`](docs/design/) — how each feature works today, one file per
  feature. Rewritten in place; no history.
- [`docs/decisions/`](docs/decisions/) — why it is the way it is. Written
  once, never edited; a change is a new record that supersedes the old one.
- [`docs/specs/`](docs/specs/) — what each run set out to do and what counted
  as done: the final plan of every run, in the order they were built.
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped when.

The features, by design doc:

| The server | The team layer |
| --- | --- |
| [Teams and keys](docs/design/teams-and-keys.md) — a key is a person on a team | [Agents and skills](docs/design/agents-and-skills.md) — the two file formats a team writes |
| [Providers](docs/design/providers.md) — the model the recorder runs on | [Workflows and the engine](docs/design/workflows-engine.md) — the YAML graph, and the walk that follows it |
| [Repositories](docs/design/repositories.md) — one name every clone agrees on | [Workspaces](docs/design/workspaces.md) — a run's own worktree |
| [The dashboard](docs/design/dashboard.md) | [Executions](docs/design/executions.md) — every run recorded, as the path it took |
| | [Memory](docs/design/memory.md) — what a run decided, for the runs after it |
| | [Cross-team](docs/design/cross-team.md) — asking another team, and objecting |
| | [The dev workflow](docs/design/dev-workflow.md) — the shipped pipeline, run from Claude Code on your machine |

## Keeping up to date

Three things move at different speeds, and only one of them needs anybody to
do anything.

- *Definitions* look after themselves: every `gate` command sends the
  mirror's hash first and pulls the bundle only when it changed, so a workflow
  edited in the dashboard is live on every machine at that machine's next
  command. A run that is already going keeps the definitions it started with.
- *The server* is your deploy. Schema migrations are idempotent on open.
  The shipped agents and workflows are seeded when a team has none; after an
  update that changes them, `npm run defaults:restore` names what the update
  left behind and `--refresh` rewrites it, with a backup.
- *The CLI* is `/gate:update`, per machine. **Anything shipped under
  `plugins/` or `src/client/` needs a version bump** — installs are cached by
  version, and `npm run build:cli` refuses to build when `plugin.json`, the
  marketplace entry and `GATE_VERSION` disagree, and warns when
  `CHANGELOG.md` has no entry for the version being built:
  `npm run changelog:release` moves what is under `Unreleased` into one.
  Every `/api/v1` response
  carries the server's version and the oldest client it will serve; a client
  below the minimum is refused with the command that fixes it.

The rest of it — what a run is, how it is driven, what happens when it stops
— is in [the dev workflow](docs/design/dev-workflow.md).
