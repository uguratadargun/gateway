# gate — the map

gate is a team's development pipeline, run from Claude Code. A team keeps its
agents, workflows and skills on the gate; each person runs those pipelines
against their own repositories from their own Claude Code session, on their
own Claude login; and the gate records what each run decided so the next run
reads it before planning — across every team of the tree it belongs to.

This page is the map: what the parts are, where the boundaries lie, and the
invariants that hold everywhere. How each part works is in `design/`, one file
per feature; why it is the way it is is in `decisions/`.

## Scope

gate holds no Claude account and serves no models. Every model call a run
makes is the person's own Claude Code, on their own machine. The gate is the
control plane around those sessions: the team's definitions, the record of
every run, the memory, the cross-team questions and objections, and the
dashboard. Every key names a person, belongs to a team, and can be revoked on
its own. → `decisions/0046-every-person-runs-on-their-own-claude-login.md`

## A run

1. **Connect.** `/gate:login <token>` writes the gate's address and the
   person's key to `~/.gate/client.json`, pulls the team's definitions, and
   writes the team's `claude-code` agents to `~/.claude/agents/` as subagents.
   Connecting spends no model call.
2. **Drive.** `/gate:run <workflow> <task>` is the only way a run happens. The
   person's session asks the CLI what to do (`gate next`), does it, and hands
   the answer back (`gate step`). An `executor: gate` node is the session's to
   do, in front of the person, who it can ask; an `executor: claude-code` node
   is a subagent of the session in the agent's own model. Command nodes are
   run by the CLI from the workflow's argv. → `design/dev-workflow.md`,
   `decisions/0047-a-run-is-driven-only-from-a-persons-session.md`
3. **Report.** Every step goes up to the client API as it lands; the dashboard
   draws the run as the path it took. The work stays on the person's machine,
   in a worktree of their clone, and the branch is published from there.
   → `design/executions.md`, `design/workspaces.md`
4. **Record.** When a run ends, the recorder on the server reads what its
   agents answered and writes the decisions it made, on a provider model the
   server names — the one model call the server makes itself. The next run's
   recall reads them. → `design/memory.md`, `design/providers.md`

## The parts

- **Teams and people.** A key is an identity: it names a person and a team,
  and a team's definitions live in a directory of their own.
  → `design/teams-and-keys.md`
- **Agents and skills.** An agent is a Markdown file with YAML frontmatter
  and a prompt; a skill is a `SKILL.md` directory, pulled from a library or
  written by hand. → `design/agents-and-skills.md`
- **Workflows.** A workflow is a YAML graph of nodes and edges; the walk
  (`nextInSession`) replays a run's recorded steps to find the next node.
  → `design/workflows-engine.md`
- **Repositories.** A repository has one name every clone of it agrees on,
  and somewhere its finished work is published to. The gate keeps a checkout
  of each connected one, which the record index and `ask` read.
  → `design/repositories.md`
- **Workspaces.** A run on a repository gets its own worktree on the person's
  machine. → `design/workspaces.md`
- **Executions.** Every run is recorded step by step, as the path it took.
  → `design/executions.md`
- **Memory.** What a run decided is recorded when it finishes, and read by
  the next run before it plans; each connected repository's own record is read
  on an interval. → `design/memory.md`
- **Cross-team collaboration.** One team asks another what its code does at a
  commit the gate fixes, and reads it on its own machine; objects to a
  decision it cannot live with; and files both under a task that outlives the
  runs. → `design/cross-team.md`
- **Providers.** Endpoints the server can call itself: the recorder's model
  and the embeddings. → `design/providers.md`
- **The dev workflow.** The shipped pipeline: recall, plan, approve,
  implement, verify, review, try, merge request. → `design/dev-workflow.md`
- **The dashboard.** The browser surface all of this is administered from,
  behind an admin session. → `design/dashboard.md`

## Invariants

**The engine decides, never a model.** A model produces output; the workflow
file decides where the run goes next. The walk takes the first edge whose
condition holds, and the last edge without a condition is the fallback. Edge
conditions are parsed into a small AST and interpreted; there is no `eval` or
`new Function` anywhere in that path, and a `command` node is spawned from an
argv array in the YAML, never from a shell string built from model output.
→ `decisions/0001-the-engine-routes-never-a-model.md`

**Every model call is the person's own.** No Claude credential is kept on the
gate, and nothing on it calls Claude. An agent's `model:` is a Claude model
the person's Claude Code resolves; a provider reference is refused on save.
→ `decisions/0046-every-person-runs-on-their-own-claude-login.md`

**Two auth surfaces, two rules.** The admin surface (dashboard and `/api/*`
management routes) needs an admin session: an HMAC-signed HttpOnly cookie
issued against `GATE_ADMIN_SECRET`, enforced in `src/middleware.ts`. The
client API (`/api/v1/*`), which the `gate` CLI on a developer's machine talks
to, takes issued API keys, hashed at rest, or `GATE_API_KEY`, and is never
open: it hands out a team's definitions and accepts run reports. A revoked key,
or a disabled person's key, stops resolving at once. Management write
endpoints validate bodies with zod.

**Secrets are sealed, never returned.** Provider API keys are AES-256-GCM
blobs under `GATE_SECRET` in their rows; the API reports whether a key is set
and nothing more. The server binds to loopback by default.

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

Runs, API keys, teams and people, providers, repositories, asks and memory live
in SQLite (`~/.gate/gate.db`, WAL) through Node's built-in `node:sqlite`; no
native build. Definitions do not: `~/.gate/teams/<team>/agents/*.md`,
`.../workflows/*.yaml` and `.../skills/<id>/SKILL.md` stay hand-editable,
diffable files, and a client mirrors its own team's copy under
`~/.gate/cache/<team>/`. Skill libraries are rows in the database, their
clones ordinary checkouts under `~/.gate/skill-sources/`. `settings.json`
stays a file. Migrations are idempotent on open; a database from before drops
what only the gateway used on its first open.

## Files

- `src/lib/providers.ts` / `provider-exec.ts` / `anthropic-openai.ts` — the endpoints the server calls itself, in both dialects · `src/providers/direct-provider.ts` — the recorder's way to one
- `src/lib/seal.ts` — AES-256-GCM sealing
- `src/agents/` — agent file format: parse, validate, render, and the tool vocabulary · `src/workflows/` — workflow YAML + condition language
- `src/skills/` — the skill library: the `SKILL.md` directory format, the team-scoped registry, git-backed sources with import provenance (`sources.ts`), and the notices a subagent carries (`inject.ts`)
- `src/runtime/` — preparing an agent node and checking its answer, command nodes, edge selection, run state, and per-run worktrees (`workspace.ts`)
- `src/executions/` — run history (SQLite) · `src/events/` — the live execution event bus
- `src/memory/` — what a run decided: the recorder, the store, recall, consolidation, teaching, forgetting, and cross-team objections
- `src/orchestration/` — one team asking another (`ask.ts`, `ask-source.ts`) and the task ledger between teams
- `src/repos/` — a repository's identity, setup and publishing
- `src/lib/teams.ts` / `apikeys.ts` / `tenancy.ts` / `def-root.ts` — people, teams, keys-as-identities, and which directory a team's definitions live in
- `src/app/api/v1/` — the client API: identity, the definition bundle, run registration, progress and stop, memory, teach, and ask
- `src/client/` — the CLI a developer's session drives a run with: the mirror, the walk (`walk.ts`), the instructions (`step.ts`), the subagent files, and the settings clean-up · `scripts/build-cli.mjs` bundles it into the plugin
- `plugins/gate/` — the Claude Code plugin: `/gate:init`, `/gate:run`, `/gate:design`, `/gate:teach`, `/gate:ask`, the authoring and documentation references, the SessionStart hook, and the bundled `gate` CLI behind them · `.claude-plugin/marketplace.json` — this repo as a marketplace
- `docs/` — this map, `design/`, `decisions/`, `specs/`; `plans/` is the pipeline's gitignored working directory
- `scripts/check-docs.mjs` — the record's form, checked; `tests/docs-record.test.ts` runs it in the suite
