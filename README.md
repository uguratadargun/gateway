# gate

A personal Claude gateway. Connect one or more Claude Code OAuth logins — plus
any other model endpoint you have, on your machine or hosted — then point any
Anthropic-compatible tool at it and each request goes to the right model (Haiku
/ Sonnet / Opus / Fable, a local model, or a GLM on Z.AI) based on the prompt's
context. On top of it, a team keeps its agents, workflows and skills, runs
multi-agent pipelines against its repositories from Claude Code, and records
what each run decided so the next run reads it first. Dashboard built with
Next.js + shadcn/ui.

> **Scope:** built around the Claude accounts *you* connect. It rotates between
> those logins and serves them to the people you issue keys to — a small team
> working through one gate, not account sharing with strangers: every key names
> a person, belongs to a team, and can be revoked on its own.

## Where to get it

```bash
git clone https://github.com/uguratadargun/gateway.git
```

The repository is also a Claude Code **marketplace** carrying one plugin, `gate`
— `/gate:run` pulls your team's workflows and runs one **on your own machine**,
in a worktree of the repository you are in, with every model call still going
through your gate; `/gate:design` designs one for that repository
([how a run works](docs/design/dev-workflow.md)):

```
/plugin marketplace add uguratadargun/gateway
/plugin install gate@gateway
```

## Setup

```bash
cp .env.example .env
# set GATE_SECRET (openssl rand -hex 32) and GATE_ADMIN_SECRET (openssl rand -hex 24)
npm install
npm run dev        # binds 127.0.0.1:4141; use `npm run dev:lan` to expose on your network
npm test           # vitest: router, OpenAI translation, SQLite storage, the engine, memory
```

Open http://localhost:4141, sign in with your admin secret, click **Start Claude
login**, approve, and paste the code Anthropic shows you.

## Using the gateway

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:4141/api/gateway claude

# Anthropic SDK
new Anthropic({ baseURL: "http://localhost:4141/api/gateway", apiKey: "unused" })
```

Requests to `model: "auto"` are routed by context. Response headers
`x-gate-model`, `x-gate-tier`, and `x-gate-route-reason` report the decision.

OpenAI SDK clients work too — point them at the same base URL and call
`/v1/chat/completions` (translated to/from Anthropic, streaming included).

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

| The gateway | The team layer |
| --- | --- |
| [Routing](docs/design/routing.md) — which model, at what effort, and why | [Teams and keys](docs/design/teams-and-keys.md) — a key is a person on a team |
| [Account pool](docs/design/account-pool.md) — more than one login, rotated before any tier drops | [Agents and skills](docs/design/agents-and-skills.md) — the two file formats a team writes |
| [Providers](docs/design/providers.md) — endpoints that are not Claude, in both dialects | [Workflows and the engine](docs/design/workflows-engine.md) — the YAML graph, and the engine that walks it |
| [The request pipeline](docs/design/gateway-pipeline.md) — cache, compression, limiter, budget, traffic | [Workspaces](docs/design/workspaces.md) — a run's own worktree and tools |
| | [Executions](docs/design/executions.md) — every run recorded, with what it cost |
| | [Memory](docs/design/memory.md) — what a run decided, for the runs after it |
| | [The dev workflow](docs/design/dev-workflow.md) — the shipped pipeline, run from Claude Code on your machine |
| | [Remote sessions](docs/design/remote-sessions.md) · [Telegram](docs/design/telegram.md) |

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
  marketplace entry and `GATE_VERSION` disagree. Every `/api/v1` response
  carries the server's version and the oldest client it will serve; a client
  below the minimum is refused with the command that fixes it.

The rest of it — what a run is, how it is driven, what happens when it stops
— is in [the dev workflow](docs/design/dev-workflow.md).
