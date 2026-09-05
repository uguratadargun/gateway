# gate

A personal Claude gateway. One Claude Code OAuth login, then an
Anthropic-compatible endpoint that routes each request to the right model
(Haiku / Sonnet / Opus) based on the prompt's context — so your account is used
efficiently. Dashboard built with Next.js + shadcn/ui.

> **Scope:** built for using **your own** Claude account through your own tools.
> It does not do multi-account rotation or account sharing.

## How it works

1. **Login** — the same Authorization-Code-with-PKCE flow Claude Code uses
   (`claude.ai/oauth/authorize` → token at `api.anthropic.com/v1/oauth/token`).
   Tokens are stored AES-256-GCM encrypted under `GATE_SECRET` and auto-refreshed.
2. **Gateway** — `POST /api/gateway/v1/messages` proxies to Anthropic on your
   OAuth token, presenting the Claude Code request shape the `claude_code` scope
   requires (identity headers + `"You are Claude Code…"` system sentinel).
3. **Routing** — `src/lib/router.ts` classifies each request into a difficulty
   category (background / trivial / agentic / default / large context / heavy)
   from its shape, then maps the category to a **model tier and an effort
   level**. Grounded in Anthropic's Sept-2026 guidance and the RouteLLM line of
   work:
   - **Effort is the primary cost lever** (API default is `high`): low for
     utility traffic, medium as the daily driver, high only for explicit heavy
     intent. Applied capability-aware — `output_config.effort` on adaptive
     models, `thinking` budgets on Haiku — and never over a client's own setting.
   - **Haiku difficulty grader** (RouteLLM's "LLM judge"): ambiguous "default"
     requests get a 1–5 grade from one tiny cached Haiku call.
   - **Cost/quality presets** (economy / balanced / quality) shift the mapping.
   - **Sticky sessions**: prompt caches are per-model and effort changes
     invalidate them, so a conversation never moves down a tier and holds effort.
   - Sonnet 5 has a 1M window at standard pricing, so large context stays on
     Sonnet; Haiku (200K) has a hard guard plus a "prompt too long" fallback.
   Fully overridable via `~/.gate/routing.json` or the dashboard.

## Setup

```bash
cp .env.example .env
# set GATE_SECRET (openssl rand -hex 32) and GATE_ADMIN_SECRET (openssl rand -hex 24)
npm install
npm run dev        # binds 127.0.0.1:4141; use `npm run dev:lan` to expose on your network
npm test           # vitest: router, OpenAI translation, SQLite storage
```

Open http://localhost:4141, sign in with your admin secret, click **Start Claude
login**, approve, and paste the code Anthropic shows you.

## Security model

- **Admin surface** (dashboard + `/api/*` management routes) requires an admin
  session: HMAC-signed HttpOnly cookie issued by `/api/admin/login` against
  `GATE_ADMIN_SECRET`, enforced in `src/middleware.ts`.
- **Gateway** (`/api/gateway/*`) uses its own auth: issued API keys (hashed at
  rest) or `GATE_API_KEY`; open when neither is configured (localhost only).
- OAuth tokens are AES-256-GCM encrypted under `GATE_SECRET`; the server binds
  to loopback by default.
- Management write endpoints validate bodies with zod (`src/lib/schemas.ts`).

## Storage

Usage, traffic, cache, API keys, and the rate-limit snapshot live in SQLite
(`~/.gate/gate.db`, WAL) via Node's built-in `node:sqlite` — no native build.
Aggregations (spend, totals) are SQL `GROUP BY`s, so budget checks stay O(1) in
request count. `settings.json` / `routing.json` stay as hand-editable files.
Pre-SQLite JSONL files are imported once and renamed `*.migrated`.

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

## Features

- **Model routing** — context-aware Haiku/Sonnet/Opus selection with aliases.
- **Rate-limit tracking** — reads Anthropic `anthropic-ratelimit-*` headers; shown live on the dashboard.
- **Tier fallback** — on 429/529, drops to a cheaper tier automatically.
- **Context compression** — trims oversized & duplicate blocks before sending.
- **Response cache** — reuses identical non-stream responses (TTL configurable).
- **Budget limits** — daily/monthly USD caps; warn or block.
- **Reasoning effort** — inject extended thinking by default or per-request (`x-gate-effort` header).
- **OpenAI-compatible endpoint** — `/v1/chat/completions`.
- **Batch API proxy** — `/v1/messages/batches/*` on your account.
- **Gateway API keys** — issue/revoke keys per tool; required once any exists.
- **Playground** — `/playground`, a chat UI over the gateway.
- **Traffic inspector** — `/traffic`, local request/response log.
- **Health daemon** — keeps the token warm; `/api/health` reports expiry.
- **Prompt-cache optimizer** — auto `cache_control` breakpoints on system/tools/last turn; cache reads tracked and priced at 10%.
- **Concurrency limiter** — max in-flight upstream requests, FIFO queue with timeout.
- **Rate-limit forecast + soft throttle** — reads the unified 5h/7d utilization headers, estimates time-to-limit, downgrades a tier at 85% and refuses at 98% (configurable).
- **Retries + in-flight dedup** — backoff on network/5xx/529, short waits on 429, identical deterministic requests coalesced.
- **Adaptive thinking** — extended-thinking effort per difficulty category.
- **`/v1/models` + `count_tokens`** — model list for SDKs/tools; exact-token routing optional.
- **OpenAI Responses API** — `/v1/responses` (Codex CLI, new SDKs), streaming included.
- **One-click client setup** — configure Claude Code from the dashboard; snippets for Cursor, Cline, OpenCode, Codex.
- **Sessions** — `/sessions`, requests grouped by conversation with cost per session.
- **Analytics** — `/analytics`, tokens/cost/requests over time by tier, per-model breakdown, table view.
- **Live tail + export** — SSE activity feed on `/traffic`; usage/traffic export as CSV/JSON.
- **Agent workflows** — `/workflows`, a graph orchestrator that runs Markdown-defined agents through the gateway: conditional loops, parallel branches, file/command tools in a per-run git worktree, and a live node view.

Everything is configurable from the dashboard (persisted to `~/.gate/settings.json`).

## Agent workflows

`/workflows` runs multi-agent pipelines — plan → implement → test → review →
security review, looping back on a failure — on top of the gateway. Every model
call goes through `executeMessages` in-process, so routing, effort, prompt
caching, budget, throttling and traffic logging apply exactly as they do for any
other client.

**The engine is deterministic.** A model produces *output*; the workflow file
decides where the run goes next. Edge conditions are parsed into a small AST and
interpreted (`src/workflows/condition.ts`) — there is no `eval`/`new Function`
anywhere in that path, and a `command` node is spawned from an argv array in the
YAML, never a shell string built from model output.

### Agents — `~/.gate/agents/<id>.md`

Markdown: YAML frontmatter says how the agent runs, the body is the prompt.

```markdown
---
name: Tester
model: sonnet          # tier alias or a concrete claude-* id; routed as usual
effort: medium         # optional: low | medium | high | xhigh | max
maxTokens: 32000       # optional output ceiling; thinking counts against it
inputs: [implementation.diff, reviewer.feedback?]
output:
  type: json           # or: text
  schema:
    passed: boolean
    failures: "string[]"
    notes: "string?"
---

Test this change:

{{inputs.implementation.diff}}
```

- `inputs` are dotted paths into upstream **node** outputs (`<nodeId>.<field>`),
  or `input.*` for the run input. A node only ever sees what it declares — the
  full state is never dumped into a prompt — and a prompt that reads an
  undeclared input fails at save time, not mid-run.
- A trailing `?` marks an input optional: it renders empty until the node that
  produces it has run. That is what makes feedback loops work — the
  implementation agent can read the tester's failures on its second pass
  without failing on its first.
- `output.type: json` is validated against the declared shape (extra keys are
  kept); an invalid answer fails the node rather than propagating silently. An
  answer cut off by the output ceiling is reported as `AGENT_OUTPUT_TRUNCATED`,
  not as bad formatting — raise `maxTokens` for agents that return long output.
- A workflow's run input is checked before anything starts: `/workflows/<id>`
  pre-fills the box with the `input.*` keys its agents read, and a run missing
  one is refused with `RUN_INPUT_MISSING` instead of failing at the first node.

### Workflows — `~/.gate/workflows/<id>.yaml`

```yaml
name: Sample dev pipeline
entry: planner
maxWorkflowSteps: 40     # hard stop for the run
maxVisits: 4             # hard stop per node — loop protection
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation

  - id: tester
    type: agent
    agent: tester
    edges:
      - when: outputs.tester.passed == true
        to: reviewer
        label: tests pass
      - to: implementation        # no `when` → the fallback edge
        label: tests failed

  - id: done
    type: terminal
```

Node types: `agent`, `command` (argv, no shell — it runs in the run's worktree
when the workflow has one), `condition` (routing only, no output), `parallel`
(below) and `terminal`. Conditions read `outputs.*` and
`input.*` with `== != > >= < <= && || !` over literals. Unknown agents, unreachable nodes,
dangling edges and malformed conditions are all rejected when the file is
saved — a broken workflow never reaches the engine.

### Running branches in parallel

Nodes that only depend on the same upstream output can run at the same time.
A `parallel` node starts every branch together and continues at its `join`
node once they have all finished:

```yaml
  - id: checks
    type: parallel
    branches: [reviewer, security]   # started together
    join: verdict                    # both must arrive here

  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict

  - id: security
    type: agent
    agent: security-reviewer
    next: verdict

  - id: verdict            # a normal condition node: both verdicts are readable
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
      - to: implementation
```

Each branch is checked at save time to be a self-contained region: branches may
not overlap, may not be entered from anywhere but the fan-out node, may not end
the workflow, and must reach the join. That is what makes concurrency safe —
two branches can never write the same node output or race for the same edge.
The shipped sample pipeline uses this for review + security review, which both
read only `implementation.diff`.

If one branch fails, the run fails: the other branches are allowed to finish
unwinding first (their in-flight model call is not cancelled) so the execution
history stays complete. Real upstream concurrency is still bounded by gate's
concurrency limiter.

Both directories are seeded with five agents and this sample pipeline the first
time you open `/agents` or `/workflows`; after that they are yours to edit (from
the dashboard or in `$EDITOR`), and deletions stick.

### Working on a repository: tools and per-run worktrees

An agent that only writes prose can plan and review, but it cannot change
anything. A workflow that declares a **workspace** gives its agents real tools:

```yaml
name: Repo dev team
entry: planner
workspace: {}                       # which repository comes from the run
```

`repo` is deliberately not part of the pipeline: a workflow describes *how* work
is done, and the project it is done in is a property of the run. Leave the
workspace empty and `repo` becomes a required run input — the run box pre-fills
it, and the `gate` plugin's `/gate-run` defaults it to the directory
you are working in, so the same pipeline serves every project. Pin one when a
pipeline only ever makes sense for a single repository:

```yaml
workspace:
  repo: /Users/you/Projects/thing   # optional: pins this pipeline to one repo
  baseRef: main                     # what the run branches from (default HEAD)
  branchPrefix: gate/run            # branch name prefix (default gate/run)
```

An explicit `repo` run input still wins over a pin.

Every run gets **its own `git worktree` on its own branch** under
`~/.gate/workspaces/<executionId>`. Agents write there, commands run there, and
your checkout and current branch are never touched — whatever the agents do,
the worst case is a branch you delete. The worktree is deliberately left behind
when the run ends: it *is* the deliverable. Review it with
`git -C <worktree> diff`, merge the branch, or throw it away with
`git worktree remove <worktree> && git branch -D <branch>`.

The tools an agent may use are declared per agent, so roles stay honest — the
implementer writes, the reviewers only read:

| tool | what it does |
| --- | --- |
| `read_file` | read a file (line-numbered, optional offset/limit) |
| `list_files` | list the tree, skipping `.git`, `node_modules`, build output |
| `search_files` | regex search across files |
| `write_file` | create or replace a file |
| `edit_file` | exact-string replace, refusing an ambiguous match |
| `run_command` | run argv in the worktree (no shell string) |

Every path an agent passes is resolved against the worktree and refused if it
escapes it — `../../.ssh/id_rsa`, an absolute path, or a symlink pointing out of
the workspace all fail. `run_command` takes an argv array, so nothing the model
writes is ever handed to a shell for interpretation; it can still run any
program, which is what makes `npm test` (and everything else) work — the isolation
that makes that acceptable is the worktree, not a command filter.

A tool that fails hands its error back to the model as a tool result, so an
agent can correct itself; an agent that keeps calling tools without answering
fails its node after 40 rounds. Tool calls are recorded on the step and streamed
live, so `/executions/<id>` shows exactly what each agent read, wrote and ran.

The same agent files still work in a workflow **without** a workspace: with no
worktree there are no tools, and the agents fall back to reasoning over what the
workflow hands them. That is the difference between the two seeded workflows —
`sample-dev-pipeline` (prose) and `repo-dev-team` (tools, `npm test` as a real
command node). The latter takes the repository it works in from the run, so it
is ready to use from wherever you start it.

### Editing the graph

`/workflows/<id>` is an editor, not just a picture. The canvas is trackpad-first
— two fingers pan in both directions, pinch zooms, and the wheel no longer
zooms — and the toolbar adds nodes of any type. Drag from a node's right handle
onto another node to connect them (on a `parallel` node that adds a branch);
click an edge and press Delete to remove it. The inspector on the right edits
the selected node: its id (every reference follows the rename), label, agent,
argv, terminal status, branches and join, and its edges with their `when`
conditions.

The canvas fills most of the page and has a full-screen mode (Escape leaves it,
and leaves the selection after that); a minimap sits in the corner for graphs
that outgrow the viewport, cards snap to the same 16px grid the background
draws, and **Tidy up** lays everything out left-to-right again.

Nothing is written until **Save graph**, which posts the graph, serializes it to
YAML server-side and runs it through the same validation a hand-edited file
gets — an unreachable node or an unknown agent comes back as the same error
message, and the file on disk is untouched. Because saving from the canvas
rewrites the file, comments in the YAML do not survive it; the **YAML** tab is
still there for hand-editing, and it refuses to open over unsaved graph edits.
Node positions are stored separately from the definition, so arranging the
canvas never touches the workflow file.

### Seeing the routing

Nothing about where a run goes next is hidden in a model: the engine takes the
first edge whose condition holds, and the last edge without a condition is the
fallback. The UI shows that in three places. On the canvas, edges that hand
control back into a node the run is still inside — `tests failed →
implementation`, `changes requested → implementation` — leave from a handle of their own under the card
and travel back on a dashed amber return lane, one lane per loop, so they never
double back through the forward flow. The **Routing** card beside it lists every point where the engine
chooses, in words. The inspector's *arrives from* section answers the same
question from the other end: what leads into this node, and under what
condition.

On `/executions/<id>` each step carries the decision that followed it, so a
finished run reads as the path it actually took (`tester → checks · tests
pass`, `verdict → implementation · changes requested`). Parallel branches
interleave in the step list, so the link out of a step is matched against the
definition rather than against its neighbour, and the last decision — into a
terminal node, which never runs as a step — is recovered from how the run
ended.

### Running

`/workflows/<id>` draws the graph and takes a JSON run input (both seeded
pipelines expect `{"task": "…"}`). During a run the page follows
`/api/executions/<id>/stream` (SSE) and highlights nodes and edges as they fire,
with a live tool-activity feed. `/executions` keeps the history — every step's
input, output, tool calls, model, tokens and duration — and `/executions/<id>`
replays the exact path a run took and links the branch it produced.

Runs can also be started over HTTP (the management API uses the admin cookie):

```bash
curl -s -c /tmp/gate.jar -H 'content-type: application/json' \
  -d "{\"secret\":\"$GATE_ADMIN_SECRET\"}" http://127.0.0.1:4141/api/admin/login
curl -s -b /tmp/gate.jar -H 'content-type: application/json' \
  -d '{"workflowId":"repo-dev-team","input":{"task":"…"}}' \
  http://127.0.0.1:4141/api/executions
```

### From Claude Code

Workflows do not run inside Claude Code — the engine calls the model through
gate's own proxy pipeline, so routing, caching and budget apply exactly as they
do for any client. What Claude Code needs is a way to start a run and read the
result. This repository is a Claude Code **marketplace** carrying one plugin,
`gate`, which is exactly that:

```
/plugin marketplace add uguratadargun/gateway
/plugin install gate@gateway
```

Then, once, from the gate checkout — the plugin is installed as a copy with no
`.env` beside it, and this is how it is given a way in:

```bash
plugins/gate/scripts/gate-workflow.mjs login    # stores the admin secret in ~/.gate/cli-secret (0600)
```

Nothing else is downloaded and nothing is added to `PATH`: the plugin is a
command file and a dependency-free Node script, and it finds its own files
through `${CLAUDE_PLUGIN_ROOT}`. The script can also be used on its own:

```bash
plugins/gate/scripts/gate-workflow.mjs list                          # what exists, and what each needs
plugins/gate/scripts/gate-workflow.mjs agents                        # what agents exist, and what each reads
plugins/gate/scripts/gate-workflow.mjs run repo-dev-team --watch "…" # start one and follow it
plugins/gate/scripts/gate-workflow.mjs watch <execution-id>          # follow one already going
plugins/gate/scripts/gate-workflow.mjs save-agent <id> <file.md>     # create or replace an agent
plugins/gate/scripts/gate-workflow.mjs save-workflow <id> <file.yaml> # create or replace a workflow
plugins/gate/scripts/gate-workflow.mjs login                         # store the secret for an installed plugin
plugins/gate/scripts/gate-workflow.mjs install                       # /gate-run without the plugin
```

It talks to `GATE_URL` (default `http://127.0.0.1:4141`) and logs in with the
admin secret, taken from the first of: `GATE_ADMIN_SECRET`, the `.env` of a
checkout named by `GATE_DIR`, a `.env` above the script itself (which is what
makes it work straight out of the repository), and finally `~/.gate/cli-secret`
as written by `login`.

The command lists the workflows you actually have every time it is invoked, so
`/gate-run` needs no ids memorised — `/gate-run` alone offers the list, and
`/gate-run repo-dev-team fix the flaky test` starts that one and follows it.
A workflow that takes a `repo` input runs against the directory you are in
(`--input repo=…` to aim it elsewhere). Because that run works in its own
worktree on its own branch, starting one from a Claude Code session never
disturbs the checkout that session is editing; when it ends, the branch and its
`git diff` are what you review.

### Designing a pipeline for a repository

`/gate-design <what it should do>` is the other half: Claude Code reads the
repository it is in — package manager, real test and lint commands, layout,
conventions — proposes a set of agents and a workflow shaped around what it
found, and, once you agree, writes them through the same validating API. It is
given the authoring reference (`plugins/gate/reference/authoring.md`) rather
than left to guess the file formats, and it is told to reuse the agents you
already have instead of producing near-duplicates.

Saving is where the safety is: the server parses and validates every agent and
workflow before it reaches disk, so a wrong definition comes back as
`prompt references undeclared input: nobody.field` or `node "check" references
unknown agent "does-not-exist"` and gets fixed, rather than failing mid-run. An
id that already exists is refused unless `--replace` is passed, so a generated
name cannot quietly overwrite an agent you tuned.

## Files

- `src/lib/claude/` — OAuth config, PKCE, token flow, Claude Code identity headers
- `src/lib/router.ts` — context-aware model routing
- `src/lib/store.ts` / `token-manager.ts` — encrypted token store + refresh
- `src/app/api/gateway/v1/messages/` — the proxy endpoint
- `src/app/api/auth/` — login flow · `src/app/api/routing/` · `src/app/api/usage/`
- `src/agents/` — agent file format: parse, validate, render · `src/workflows/` — workflow YAML + condition language
- `src/runtime/` — the deterministic engine, node executors, agent tools (`tools/`) and per-run worktrees (`workspace.ts`) · `src/providers/` — the `ModelProvider` seam onto the gateway
- `src/executions/` — run history (SQLite) · `src/events/` — the live execution event bus
- `plugins/gate/` — the Claude Code plugin: `/gate-run`, `/gate-design`, the authoring reference and the shell client behind them · `.claude-plugin/marketplace.json` — this repo as a marketplace
