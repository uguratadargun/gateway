# gate — the map

gate is a personal Claude gateway with a team's development pipeline on top of
it. One or more Claude Code OAuth logins are connected, plus any other model
endpoint you have; any Anthropic-compatible tool is pointed at the gate, names
the model it wants, and gets it — served by whichever account still has window,
at the effort the client asked for. On the same gateway, a team keeps agents, workflows and skills,
runs multi-agent pipelines against its repositories from Claude Code, and
records what each run decided so the next run reads it before planning.

This page is the map: what the parts are, where the boundaries lie, and the
invariants that hold everywhere. How each part works is in `design/`, one file
per feature; why it is the way it is is in `decisions/`.

## Scope

Built around the Claude accounts *you* connect. It rotates between those
logins and serves them to the people you issue keys to: a small team working
through one gate, not account sharing with strangers. Every key names a person,
belongs to a team, and can be revoked on its own.

## The request path

1. **Login.** The same Authorization-Code-with-PKCE flow Claude Code uses.
   Tokens are sealed AES-256-GCM under `GATE_SECRET` and refreshed on their
   own. Each login keeps its own device id, so one machine's accounts are not
   correlated upstream.
2. **Gateway.** `POST /api/gateway/v1/messages` proxies to Anthropic on an
   OAuth token, presenting the request shape the `claude_code` scope requires.
   OpenAI-dialect clients call `/v1/chat/completions` on the same base URL and
   are translated both ways, streaming included.
3. **Model resolution.** The name the caller sent is resolved to an endpoint:
   a provider model, a concrete `claude-*` id, or a tier alias. gate never
   picks a model the caller did not name, and a name it cannot resolve is a
   400. Effort is the one cost lever it still turns. → `design/routing.md`
4. **Account pool.** With more than one login connected, a rate-limited account
   is parked until its window resets and the next one takes over.
   → `design/account-pool.md`
5. **Providers.** A tier or an agent can point at something that is not a
   Claude account: a model on your machine, or a hosted endpoint.
   → `design/providers.md`

Between resolution and the provider sits the pipeline every request goes
through: cache, compression, the limiter, in-flight tracking, budget, usage
and traffic logging. → `design/gateway-pipeline.md`

## The team layer

- **Teams and people.** A key is an identity: it names a person and a team,
  and a team's definitions live in a directory of their own.
  → `design/teams-and-keys.md`
- **Agents and skills.** An agent is a Markdown file with YAML frontmatter
  and a prompt; a skill is a `SKILL.md` directory, pulled from a library or
  written by hand. → `design/agents-and-skills.md`
- **Workflows and the engine.** A workflow is a YAML graph of nodes and
  edges; the engine walks it. → `design/workflows-engine.md`
- **Repositories.** A repository has one name every clone of it agrees on,
  a setup gate can run, and somewhere its finished work is published to.
  → `design/repositories.md`
- **Workspaces.** A run on a repository gets its own worktree and the tools
  to work in it. → `design/workspaces.md`
- **Executions.** Every run is recorded step by step, with what it cost and
  which account's window it used. → `design/executions.md`
- **Memory.** What a run decided is recorded when it finishes, and read by
  the next run before it plans. → `design/memory.md`
- **Cross-team collaboration.** One team asks another what its code does at a
  named commit, objects to a decision it cannot live with, and files both
  under a task that outlives the runs. → `design/cross-team.md`
- **The dev workflow.** The shipped pipeline: recall, plan, approve,
  implement, verify, review, try, merge request — run on the developer's own
  machine from Claude Code. → `design/dev-workflow.md`
- **Remote sessions** and **Telegram** are two more places a run can be
  driven from. → `design/remote-sessions.md`, `design/telegram.md`
- **The dashboard.** The browser surface all of this is administered from,
  behind an admin session. → `design/dashboard.md`

Every model call a workflow makes goes through `executeMessages` in-process,
so model resolution, effort, prompt caching, budget, quota protection and
traffic logging apply exactly as they do for any other client.

## Invariants

**The engine decides, never a model.** A model produces output; the workflow
file decides where the run goes next. The engine takes the first edge whose
condition holds, and the last edge without a condition is the fallback. Edge
conditions are parsed into a small AST and interpreted; there is no `eval` or
`new Function` anywhere in that path, and a `command` node is spawned from an
argv array in the YAML, never from a shell string built from model output.
→ `decisions/0001-the-engine-routes-never-a-model.md`

**Three auth surfaces, three rules.** The admin surface (dashboard and
`/api/*` management routes) needs an admin session: an HMAC-signed HttpOnly
cookie issued against `GATE_ADMIN_SECRET`, enforced in `src/middleware.ts`.
The gateway (`/api/gateway/*`) takes issued API keys, hashed at rest, or
`GATE_API_KEY`, and is open when neither is configured, on localhost only.
The client API (`/api/v1/*`), which the `gate` CLI on a developer's machine
talks to, takes the same keys and is never open: it hands out a team's
definitions and accepts run reports. A revoked key, or a disabled person's
key, stops resolving at once. Management write endpoints validate bodies with
zod.
→ `decisions/0011-three-auth-surfaces-three-rules.md`

**Secrets are sealed, never returned.** OAuth tokens and provider API keys
are AES-256-GCM blobs under `GATE_SECRET` in their rows; the API reports
whether a key is set and nothing more. The server binds to loopback by
default.

**Rate-limit state belongs to an account, not to gate.** Each connected login
carries its own 5h / 7d window snapshot, and disconnecting the last one
forgets the shared history. When the throttle refuses, the 429 says it is
gate's, not Anthropic's, and names how many accounts it tried.

**A run is recorded as the path it took.** Each step carries the decision
that followed it, so a finished run reads as `tester → checks · tests pass`,
not as a log to be reconstructed.

**The repository keeps its own record.** How a feature works is in
`docs/design/`, why in `docs/decisions/`, what a run set out to do in
`docs/specs/`. The pipeline writes them with the code and holds a change
against them; memory indexes them, it does not replace them. The form of
the record is checked by code inside `npm test`; its truth by the reviewer.
→ `decisions/0005-docs-as-code-in-every-repository.md`, `design/the-record.md`

## Storage

Usage, traffic, cache, API keys, connected accounts, providers, memory and
the rate-limit snapshot live in SQLite (`~/.gate/gate.db`, WAL) through
Node's built-in `node:sqlite`; no native build. Teams, people and their keys
live in the same database. Definitions do not: `~/.gate/teams/<team>/agents/*.md`,
`.../workflows/*.yaml` and `.../skills/<id>/SKILL.md` stay hand-editable,
diffable files, and a client mirrors its own team's copy under
`~/.gate/cache/<team>/`. Skill libraries are rows in the database, their
clones ordinary checkouts under `~/.gate/skill-sources/`. Aggregations are
SQL `GROUP BY`s, so budget checks stay O(1) in request count. `settings.json`
and `routing.json` stay as files. Pre-SQLite JSONL files are imported once and
renamed `*.migrated`; a pre-pool `credentials.json` is folded into the
accounts table the same way, so a single-account install keeps its login on
upgrade.

## Files

- `src/lib/claude/` — OAuth config, PKCE, token flow, Claude Code identity headers
- `src/lib/router.ts` — model name resolution: provider refs, concrete ids, tier aliases
- `src/lib/accounts.ts` / `account-pool.ts` / `token-manager.ts` — the account pool: sealed token store, selection strategies, cooldowns, per-account refresh
- `src/lib/providers.ts` / `provider-exec.ts` / `anthropic-openai.ts` — non-Claude endpoints in both dialects: the Anthropic↔OpenAI translation, and the Anthropic-dialect forward
- `src/lib/seal.ts` / `store.ts` — AES-256-GCM sealing; the credential shape and the pre-pool file reader
- `src/app/api/gateway/v1/messages/` — the proxy endpoint
- `src/app/api/auth/` — login flow · `src/app/api/accounts/` · `src/app/api/providers/` · `src/app/api/routing/` · `src/app/api/usage/`
- `src/agents/` — agent file format: parse, validate, render · `src/workflows/` — workflow YAML + condition language
- `src/skills/` — the skill library: the `SKILL.md` directory format, the team-scoped registry, git-backed sources with import provenance (`sources.ts`), and how a skill reaches each executor (`inject.ts`)
- `src/runtime/` — the deterministic engine, node executors, agent tools (`tools/`) and per-run worktrees (`workspace.ts`) · `src/providers/` — the `ModelProvider` seam onto the gateway
- `src/executions/` — run history (SQLite) · `src/events/` — the live execution event bus
- `src/memory/` — what a run decided: the recorder, the store, recall, consolidation, teaching, forgetting, and cross-team objections
- `src/orchestration/` — one team asking another (`ask.ts`) and the task ledger between teams
- `src/repos/` — a repository's identity, setup and publishing
- `src/remote/` — a Claude Code session on the server, driven over the client API · `src/telegram/` — the bot
- `src/lib/teams.ts` / `apikeys.ts` / `tenancy.ts` / `def-root.ts` — people, teams, keys-as-identities, and which directory a team's definitions live in
- `src/app/api/v1/` — the client API: identity, the definition bundle, run registration, progress and stop, memory, teach, ask, and the pool's remaining quota
- `src/client/` — the CLI that runs a workflow on a developer's machine: the mirror, the HTTP provider onto the gateway, and the reporter · `scripts/build-cli.mjs` bundles it into the plugin
- `plugins/gate/` — the Claude Code plugin: `/gate:init`, `/gate:run`, `/gate:design`, `/gate:teach`, `/gate:ask`, the authoring and documentation references, and the bundled `gate` CLI behind them · `.claude-plugin/marketplace.json` — this repo as a marketplace
- `docs/` — this map, `design/`, `decisions/`, `specs/`; `plans/` is the pipeline's gitignored working directory
- `scripts/check-docs.mjs` — the record's form, checked; `tests/docs-record.test.ts` runs it in the suite
