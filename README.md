# gate

A personal Claude gateway. Connect one or more Claude Code OAuth logins — plus
any other model endpoint you have, on your machine or hosted — then point any
Anthropic-compatible tool at it and each request goes to the right model (Haiku
/ Sonnet / Opus / Fable, a local model, or a GLM on Z.AI) based on the prompt's
context. Dashboard built with Next.js +
shadcn/ui.

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
([details](#from-claude-code--runs-happen-on-your-machine)):

```
/plugin marketplace add uguratadargun/gateway
/plugin install gate@gateway
```

## How it works

1. **Login** — the same Authorization-Code-with-PKCE flow Claude Code uses
   (`claude.ai/oauth/authorize` → token at `api.anthropic.com/v1/oauth/token`).
   Tokens are stored AES-256-GCM encrypted under `GATE_SECRET` and auto-refreshed.
   Repeat it to add a second account; each login keeps its own device id, so one
   machine's accounts are not correlated upstream.
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
4. **Account pool** — with more than one login connected, a rate-limited account
   is parked until its window resets and the next one takes over *before* any
   tier is downgraded (see [Account pool](#account-pool)).
5. **Providers** — a tier or an agent can point at something that is not a
   Claude account: a model on your own machine, or a hosted endpoint like Z.AI
   (see [Providers](#providers)).

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
- **Client API** (`/api/v1/*`) — what the `gate` CLI on a developer's machine
  talks to — takes the same keys but is **never open**: it hands out a team's
  definitions and accepts run reports, so an unauthenticated caller there would
  be handed every workflow the team has written. A key names a person and a
  team; a revoked key, or a disabled person's key, stops resolving at once.
- OAuth tokens are AES-256-GCM encrypted under `GATE_SECRET`; the server binds
  to loopback by default.
- Management write endpoints validate bodies with zod (`src/lib/schemas.ts`).

Rate-limit state belongs to an account, not to gate: each connected login
carries its own 5h / 7d window snapshot, and disconnecting the last one forgets
the shared history. Kept across accounts they would describe someone else's
quota — and the throttle would refuse a fresh account's requests on the strength
of an exhausted one. When the throttle does refuse, it says so in the response:
that 429 is gate's, not Anthropic's, and it names how many accounts it tried.

Providers get the same treatment as accounts: their API keys are sealed under
`GATE_SECRET` and never returned by the API — the dashboard sees only whether a
key is set.

## Teams and people

`/team` is where a person becomes able to connect: add a team, add someone to
it, issue them a key. The key is shown once, as the command they run:

```bash
gate login --url https://gate.internal --key gate_…
```

A **team owns its agents and workflows** — `~/.gate/teams/<team>/` — and a key
can only ever read its own team's. A **person** has one team and one or more
keys; moving them to another team moves their keys with them, disabling them
stops every key they hold, and deleting them revokes the lot. Everything that
existed before teams belongs to `default`, and an install that had
`~/.gate/agents` and `~/.gate/workflows` has them moved under it on first read —
a single-person gate keeps working with nothing to do.

Keys carry scopes: `gateway` (model calls), `workflows` (pull definitions,
report runs) and `author` (write them). A key for a third-party tool can be
issued `gateway` only. `author` is off by default and ticked deliberately when
the key is issued: reading a team's definitions is what everyone on it needs,
writing them is a decision about that team's pipelines.

## Storage

Usage, traffic, cache, API keys, connected accounts, providers, and the
rate-limit snapshot live in SQLite (`~/.gate/gate.db`, WAL) via Node's built-in
`node:sqlite` — no native build. Account tokens and provider API keys are sealed
blobs in their rows, not plain columns.
Teams, people and their keys live in the same database. Definitions do not:
`~/.gate/teams/<team>/agents/*.md`, `.../workflows/*.yaml` and
`.../skills/<id>/SKILL.md` stay hand-editable and diffable files, and a client
mirrors its own team's copy under `~/.gate/cache/<team>/`. Skill libraries gate
pulls from are rows in the database, but their clones are ordinary checkouts
under `~/.gate/skill-sources/`.
Aggregations (spend, totals) are SQL `GROUP BY`s, so budget checks stay O(1) in
request count. `settings.json` / `routing.json` stay as hand-editable files.
Pre-SQLite JSONL files are imported once and renamed `*.migrated`, and the
pre-pool `credentials.json` is folded into the accounts table the same way — an
existing single-account install keeps its login on upgrade.

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

## Account pool

Connect a second login from the dashboard and gate stops being a single-account
proxy. Every request picks an account first, and only then a model.

```
Claude Code ──▶ gate ──▶ pick account ──▶ pick tier ──▶ api.anthropic.com
                              │
                              └─ 429 (account-wide) ─▶ park it, next account, same model
                                 429 (model-specific) ─▶ same account, cheaper tier
```

That order is the point. A cheaper model on an **exhausted account** is served
by the same exhausted quota, so rotating accounts has to come first; a
**model-specific** limit is the opposite — the account is healthy, and dropping
a tier is the cheap fix. Parking a healthy account for the second case would
take it out of the pool for everything else, so gate does not.

**Rotation strategies** (Settings → the accounts card):

| Strategy | Picks |
| --- | --- |
| `fill-first` (default) | The highest-priority account until its window runs out. One prompt cache stays hot. |
| `round-robin` | Sticks for N requests, then rotates to the least-recently-used account. |
| `least-used` | Always the account idle longest. Never-used accounts go first. |
| `p2c` | Two at random, the healthier of the two. |
| `random` | Uniform among available accounts. |

Availability is not just "enabled": an account is skipped while it is cooling
down after a rate limit, and — if you set a floor — while any quota window has
less than that percentage left. Cooldowns follow the upstream: `Retry-After`
wins, an exhausted quota waits for its window reset, and anything else backs off
5 s · 2ⁿ up to two minutes.

Each account's 5h / 7d windows come from the `anthropic-ratelimit-unified-*`
headers on every reply, so a busy account's bars stay current for free. Those
headers only exist on a reply, though — a **just-connected account has no window
reading at all** — so gate also reads Claude's own usage endpoint
(`/api/oauth/usage`, the one the CLI uses; no inference, no tokens spent).

Anthropic rate-limits that endpoint separately from `/v1/messages`, so gate asks
it as little as it can get away with:

- **A busy account is never polled.** Its replies already stamped the same
  snapshot, so it never looks stale.
- **The dashboard polls only an account that has never been polled at all** —
  enough to fill a new account's bar, and nothing more. A page left open, or
  reloaded while reordering the pool, triggers nothing.
- **Periodic refresh is the daemon's job**, once per `quotaRefreshMinutes`
  (default 30 — slow on purpose against a 5h window).
- **Failures back off**: 10 min, doubling per consecutive failure, capped at 4 h;
  a 429 additionally pauses that token for three minutes. Chat is untouched
  either way, and the panel shows the reason instead of a blank bar.

`x-gate-account` on the response names the login that served the request.

## Providers

A **provider** is any model endpoint that is not one of the connected Claude
accounts: Ollama, vLLM, LM Studio or llama.cpp on your own machine, and hosted
ones like Z.AI. Add it under **Providers** on the dashboard (there are one-click
presets), and its models appear as `provider:<name>/<model>` in every model
picker — tiers, agents, and a client naming one directly.

gate speaks two dialects, and which one a provider gets is the only real choice
when adding it:

| | `openai-compat` | `anthropic-compat` |
| --- | --- | --- |
| endpoint | `POST {baseUrl}/chat/completions` | `POST {baseUrl}/v1/messages` |
| who | Ollama, vLLM, LM Studio, llama.cpp, most hosted APIs | Z.AI, and anything else that publishes a Messages API |
| what gate does | translates the request out and the answer back | forwards it as it stands |

```
routing.json → tiers.haiku = "provider:ollama/qwen3-coder"

Claude Code ──▶ /v1/messages (Anthropic)
                   │  anthropicToOpenAIRequest
                   ▼
              POST localhost:11434/v1/chat/completions
                   │  openAIStreamToAnthropic
                   ▼
Claude Code ◀── Anthropic SSE
```

gate speaks Anthropic end to end, so the OpenAI translation is a real round
trip, not a passthrough: system blocks are hoisted into a system message,
`tool_use` becomes `tool_calls`, `tool_result` becomes the `role: "tool"`
messages OpenAI expects (ordered so each answers the call before it), images
become data URLs, and thinking blocks — whose signatures only Anthropic can
verify — are dropped. On the way back, the OpenAI chunk stream is rebuilt into
the full Anthropic event sequence, `message_start` through `message_stop`, with
tool arguments streamed as `input_json_delta`. `stream_options.include_usage` is
requested on every stream, because without it most OpenAI-compatible servers
report no usage at all and the request would be accounted as zero tokens.

An `anthropic-compat` provider skips all of that. The body is forwarded with the
model id swapped and the provider's key attached, and the answer — JSON or SSE —
is handed back byte for byte. Tool blocks, cache breakpoints and streamed
thinking reach the model exactly as the client wrote them. Only the parameters
that are Anthropic's alone are stripped, because a third-party endpoint answers
400 on them and they arrive constantly: `output_config`, `context_management`,
and `thinking: adaptive` (Claude Code sends the last two on every request).

### Z.AI (GLM)

Z.AI publishes a Messages API endpoint, which is what makes it worth forwarding
to untranslated. Add it as:

```
Name       zai
Dialect    Anthropic-compatible
Base URL   https://api.z.ai/api/anthropic
API key    (from your Z.AI console)
Models     glm-5.3, glm-5.3-flash
```

That is the same endpoint Z.AI documents for pointing Claude Code at GLM. The
only difference is who the client talks to: their setup puts
`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` in your shell and the
traffic leaves your account unmetered, while gate keeps the middle seat — same
endpoint, same untranslated body, but routed, logged and counted.

The **Models** field matters here: that endpoint serves no catalogue to
discover, so gate would otherwise have nothing to put in the pickers. Filled in,
the list you write *is* the catalogue and nothing is probed. Leave it empty for
anything that answers `/models` on its own — an Ollama, say.

Then point whatever you like at it: a tier in `routing.json`, or an agent —

```yaml
model: provider:zai/glm-5.3
executor: claude-code
```

— which runs that node's loop in a headless Claude Code whose every call still
goes through gate, and is therefore routed, metered, logged and counted against
the run's budget the same as a Claude call would be.

A node on a provider model also gets `ANTHROPIC_DEFAULT_SONNET_MODEL` and its
`HAIKU` / `OPUS` siblings pinned to that same model — the mechanism Z.AI
documents for the same purpose. Without it the child's own background work asks
for the `haiku` alias, gate resolves that alias onto a Claude tier, and a node
you asked to run on GLM would still need a connected Claude account to answer
traffic you never asked for. Pinned, a gate with no Claude login at all runs
that node end to end. (The child logs one `unrecognized_model` line for a model
id it does not know; it sends the request regardless.)

Practical notes:

- A provider model **costs nothing on the Anthropic bill** — whatever it may
  cost on its own — and usage accounting prices it at zero rather than as the
  tier it stands in.
- An endpoint on loopback, RFC1918, or a `.local` / `.internal` / `.lan` name is
  labelled *on your network*; anything routable publicly, Z.AI included, is
  labelled *remote*.
- If the endpoint is down, the tier fallback chain takes over — an unplugged
  Ollama drops to the next tier rather than failing the request.
- You can also address one directly, without touching routing:
  `model: "provider:ollama/qwen3-coder"`.
- The prefix used to be `local:`, which was never true of a hosted endpoint.
  Both parse, forever: a `routing.json` or an agent written before the rename
  keeps resolving, and is canonicalised to `provider:` on the way through.

## Features

- **Model routing** — context-aware Haiku/Sonnet/Opus/Fable selection with aliases.
- **Account pool** — several Claude logins behind one endpoint, with five rotation strategies and per-account quota.
- **Providers** — route any tier or agent to Ollama / vLLM / LM Studio / llama.cpp, or to a hosted endpoint like Z.AI, streaming included.
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
- **Health daemon** — keeps every account's token warm; `/api/health` reports expiry per account.
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
- **Runs on your own machine** — `gate run` (and `/gate:run`) executes the same workflow in your terminal, in a worktree of the repo you are in, with the model calls, the history and the live view still on the server.
- **Teams and keys** — `/team`, a person per key, a team per set of definitions; revoke a key or disable a person and their access stops.

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

### Agents — `~/.gate/teams/<team>/agents/<id>.md`

Markdown: YAML frontmatter says how the agent runs, the body is the prompt.

```markdown
---
name: Tester
model: sonnet          # tier alias or a concrete claude-* id; routed as usual
effort: medium         # optional: low | medium | high | xhigh | max
maxTokens: 32000       # optional output ceiling; thinking counts against it
skills: [superpowers-test-driven-development]   # optional; see Skills below
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
- `skills` names entries from the team's skill library, and is how the agent
  works rather than what it may touch. An agent that declares one is told to
  follow it every run; a skill the team cannot resolve is refused at save time.
- A workflow's run input is checked before anything starts: `/workflows/<id>`
  pre-fills the box with the `input.*` keys its agents read, and a run missing
  one is refused with `RUN_INPUT_MISSING` instead of failing at the first node.

### Skills — `~/.gate/teams/<team>/skills/<id>/SKILL.md`

A skill is a process an agent is told to follow, written as the same
`SKILL.md` directory Claude Code and the published libraries already use:
`name` and `description` in the frontmatter, the process below it, and
whatever files that process points at beside it.

```markdown
---
name: superpowers-brainstorming
description: Use before any creative work — explores intent and design before implementation.
---

Ask clarifying questions one at a time. Propose 2–3 approaches with trade-offs.
Present the design and get approval before writing code.
```

How it reaches the model depends on which loop is running the node, but it
means the same thing either way:

- **`executor: claude-code`** — gate assembles the skills that agent named into
  a throwaway plugin and starts the child with `--plugin-dir`, so each one
  loads as `gate-skills:<id>` with its own files beside it and the harness
  opens it when it is due. The bundle is content-addressed under
  `~/.gate/skill-bundles/`, so the same set is built once and a changed skill
  gets a new address rather than a stale plugin.
- **`executor: gate`** — gate's own loop has no notion of a skill and no way to
  read a file outside the worktree, so the skill's prose is folded into the
  system prompt. Files a skill ships are named and explicitly marked
  unreadable, rather than being pointed at and quietly missing.

Skills ride along in the client bundle, so a run on a developer's own machine
follows the same process the server would.

#### Pulling a library — the Skills page

The skills worth having are mostly written elsewhere, so gate clones a library
and imports from it as two separate acts. **Sync** fetches into gate's own
clone and changes nothing a team runs; **Import** copies named skills into the
team's library and stamps each with the commit it came from. Nothing an agent
does changes until somebody asks for it.

Because the stamp is kept, every skill on the page says where it stands:
*not imported*, *up to date*, *update available*, or *edited here* — the last
being the one an update would overwrite, said before you press the button.

[`superpowers`](https://github.com/obra/superpowers) ships registered and
unpulled, under the `superpowers-` prefix so a second library shipping its own
`brainstorming` does not collide. One Sync, then import what you want:

```
Skills → Superpowers → Sync → browse → pick brainstorming → Import
Agents → planner → Skills → ☑ superpowers-brainstorming → Save
```

Add your own library with a git URL, a ref, the subdirectory its skills live in
and an id prefix. Forgetting a source deletes gate's clone; the skills already
imported are the team's copies and stay.

### Workflows — `~/.gate/teams/<team>/workflows/<id>.yaml`

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
(below) and `terminal`. An `agent` or `command` node can carry `disabled: true`,
which switches the step off without taking it out of the graph: runs walk
straight past it — nothing called, nothing spent, no step recorded and no visit
counted — and continue along one of the node's own edges, named by `skipTo`
when it has more than one. Conditions read `outputs.*` and
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

gate ships one team that works in a repository nobody has looked at:
**planner**, **implementer** and **reviewer**, each following skills from
`superpowers` (brainstorming, using git worktrees and writing plans; executing
plans, test-driven development and subagent-driven development; requesting
code review), plus three agents that follow no skill and decide nothing —
they are where the pipeline turns to the person. **clarify** carries the
planner's questions to them and their answers back, since the planner runs in
its own model and cannot ask from there. **plan-review** shows them the plan,
and nothing is built until they say so — once; a plan revised after a review,
or after their own requests on the branch, goes straight back to the
implementer rather than being shown again. **acceptance** tells them the branch
is ready and how to try it (`git merge <branch>`), and only their answer opens
the merge request or sends their requests back to the planner. Together they
make a `dev` pipeline that plans with the person, builds once they approve,
reviews, commits, asks, and opens a merge request. The prompts are written against
what those skills do without a person in the session — where one would wait
for approval, the planner rules and records the ruling; because they commit
task by task, the pipeline diffs against the commit the run started from and
lets the commit node find nothing left to commit; where one hands off to a
finishing skill, the implementer stops and the pipeline ships.

It contains no `npm ci` and no `npm test` on purpose — those are facts about
one project, and a default that assumes them fails on the first machine it
meets. What a particular repository needs goes around it, and `/gate:design`
writes exactly that: install and codegen before the planner, its real test
command between the implementer and the review, a merge-request node matching
its host, and — only where the project genuinely has a second thing that must
be checked every time — one or two extra reviewers running alongside the
default one. The three agents themselves are named, never copied.

The skills are the point: without them these are three ordinary prompts. If the
team has not imported them, `/skills` says which are missing and imports them in
one button, and a run that needs one stops at that node with the reason rather
than quietly proceeding without it.

The **default team's** directories are seeded with the three agents below and
the `dev` pipeline the first time you open `/agents` or `/workflows`; after that they are yours to edit (from
the dashboard or in `$EDITOR`), and deletions stick. A team you create starts
**empty**: it is a place someone made for their own work, and two pipelines
nobody wrote — one of which runs `npm ci` on whichever machine picks it up — is
not a helpful welcome.

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
it, and the `gate` plugin's `/gate:run` defaults it to the directory
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
workflow hands them. That is the difference between a pipeline with a
`workspace` and one without (tools, and a project's own `npm ci` / `npm test`
as real command nodes — a worktree is a clean checkout, so dependencies are
installed once before the loop, and an install that fails ends the run instead
of sending the implementer after an error it cannot fix). The latter takes the repository it works in from the run, so it
is ready to use from wherever you start it.

### Editing the graph

`/workflows/<id>` is an editor, not just a picture. The canvas is trackpad-first
— two fingers pan in both directions, pinch zooms, and the wheel no longer
zooms — and the toolbar adds nodes of any type. Drag from a node's right handle
onto another node to connect them (on a `parallel` node that adds a branch);
click an edge and press Delete to remove it. The inspector on the right edits
the selected node: its id (every reference follows the rename), label, agent,
argv, terminal status, branches and join, and its edges with their `when`
conditions. **Turn off** takes a step out of the run without deleting it — the
card stays on the canvas, dimmed and marked `off`, and runs walk past it along
the edge the inspector names.

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

### Which team a definition belongs to

Every agent and workflow belongs to exactly one team — that is what makes "this
team's workflows" a set anyone can reason about, and what a key resolves to
when a client pulls. `/agents` and `/workflows` carry a team switcher when
there is more than one team, and the choice rides in the URL, so a link to
another team's pipeline is a link rather than a screenshot.

Assigning one elsewhere is therefore a **move**, offered on the same selection
bar that deletes: tick the rows, pick a team. A workflow is written into the
destination through the same validation a hand-edited file gets, so one whose
agents are still behind is refused there — with that reason — and stays where
it works, rather than landing broken and disappearing from where it ran. Move
the agents first; the confirmation says so. A definition that no longer parses —
usually because the agents it names went somewhere else — is selectable in the
error card for exactly this reason: it is the one you most need to move or
delete, and listing it while making it untouchable is how a workflow becomes
unreachable from the page that owns it. An agent that leaves workflows
behind naming it is not refused, because it is your file and deleting one has
never been refused either, but the workflows that will stop loading are named.

### Clearing things out

`/agents`, `/workflows` and `/executions` select. A row shows its checkbox on
hover; once anything is ticked, a small bar floats over the list with `Select
all`, `Cancel` and `Delete`, and disappears again when the selection is empty —
a list you are only reading looks like a list. Deleting stayed one-at-a-time on
the detail pages for a long time, which made a clear-out a tour of every item.

Two things are said out loud rather than discovered afterwards. An agent row
shows how many workflows name it, and deleting one that is in use names them and
warns that they stop loading until they are edited — nothing refuses the
deletion, it is your file. And deleting runs removes history only: the worktrees
those runs produced are the deliverable, so they stay on disk, and the dialog
says so rather than leaving you to assume branches were cleaned up. The CLI
takes the same line: `delete-agent` refuses an agent a workflow still names
unless `--force`.

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

`/workflows/<id>` draws the graph and takes a JSON run input (the seeded
pipeline expects `{"task": "…"}`). During a run the page follows
`/api/executions/<id>/stream` (SSE) and highlights nodes and edges as they fire,
with a live tool-activity feed. `/executions` keeps the history — every step's
input, output, tool calls, model, tokens and duration — and `/executions/<id>`
replays the exact path a run took and links the branch it produced.

A run can be stopped: **Stop** on the execution page, or `gate cancel
<execution-id>`. The engine checks for it before every
node *and* inside an agent's tool loop, so a stop does not wait out a step that
is making a dozen tool calls; the upstream model request is really aborted, and
a running command node's child process is killed rather than abandoned. The run
settles as `failed` with `RUN_CANCELLED`, and its worktree is kept — half-done
work is still work, and `git diff` will show it.

A stopped run offers two ways back on the execution page — for a run that
happened here; one that happened on someone's machine is continued there.
**Restart** begins the workflow fresh — a new worktree from HEAD, the same
input — and **Continue** picks up in the *same* worktree, at the node
it stopped on, without redoing what already ran. Where it resumes falls out of
history alone: a step that failed is retried; a step that finished cleanly
means the run stopped between nodes, so the node after it is re-derived with
the same routing the engine itself uses. Nothing branches on *why* the run
stopped — cancelled, hit a ceiling, an upstream hiccup, all reduce to the same
two cases.

The loop and step ceilings stay real ceilings across a Continue: the visit
count carried into the resumed run is the *cumulative* count across every run
in the chain, never reset. A run that hit `maxVisits` lands back on the very
node that tripped it, already at the limit, and halts again immediately —
at no cost — rather than a Continue click quietly buying the workflow another
five tries. Continue refuses outright (with a plain reason) for a run that is
still going, one that already finished at a terminal, or one whose worktree no
longer exists on disk.

### What a run cost

An execution shows what it used: its own tokens and API-equivalent cost, summed
from its steps, so concurrent runs and ordinary Claude Code traffic are never in
that number. It also estimates its share of the 5-hour and weekly rate-limit
windows — the API reports where a window stands, never what one run moved it by,
so the run's slice is attributed by its share of the cost of everything the
gateway sent inside that window, and is labelled as an estimate.

A step that refuses says so where it happened: the failing lines are lifted out
of its output and shown under it in the step list, and again at the top of a
failed run as what ended it — which node refused, with what, and how many of its
attempts it refused. A gate that refused every attempt is called out as having
been red before the run started. The extraction drops terminal colour codes,
update banners and stack frames, and keeps assertions, type errors and FAIL
lines; the same summary is printed by `--watch`, so a run explains itself in the
terminal too.

When a run stops at the loop ceiling, the error names what kept sending it back
(`node "implementation" ran 6 times (max 5); last sent back by "tests" (exit 1)`)
— a gate that was already red before the run started looks exactly like this, and
that is worth being able to see. Step output is stripped of terminal colour codes,
because a failing suite is what you open the step to read.

Nothing survives a restart, so any run left at `running` by a stopped server is
settled at boot as `RUN_INTERRUPTED` instead of sitting there claiming to be
alive. Deleting a run from the history is not a way to stop it: that removes the
record, not the work.

Runs can also be started over HTTP (the management API uses the admin cookie):

```bash
curl -s -c /tmp/gate.jar -H 'content-type: application/json' \
  -d "{\"secret\":\"$GATE_ADMIN_SECRET\"}" http://127.0.0.1:4141/api/admin/login
curl -s -b /tmp/gate.jar -H 'content-type: application/json' \
  -d '{"workflowId":"dev","input":{"task":"…"}}' \
  http://127.0.0.1:4141/api/executions
```

### From Claude Code — runs happen on your machine

A run does not have to happen on the server. The engine is a library: give it
definitions, a worktree and a way to reach a model, and it walks the same graph
wherever it is. The `gate` plugin does exactly that — it runs the workflow **in
your terminal**, in a worktree of the repository you are in, and leaves the
server doing what only it can do: holding the definitions, serving the model
calls, and keeping the history.

```
/plugin marketplace add uguratadargun/gateway
/plugin install gate@gateway
```

Then, once per machine, one line — the `/team` page hands it over ready to send:

```
/gate:login gatec_eyJ1IjoiaHR0cHM6Ly9nYXRlLmludGVybmFsIiwiayI6ImdhdGVfL…
```

That token carries both the gate's address and the person's key, so there is
nothing to type twice and nothing to get in the wrong order; it is written to
`~/.gate/client.json` (0600) and their team's definitions are pulled on the
spot. A key pasted where a token goes says so rather than failing as a
malformed token.

In a terminal the same thing is `gate login <token>` — and `gate install`
writes a `gate` shim into `~/.local/bin` for it, which `/gate:login` and
`/gate:run` do not need (they call the bundled script by absolute path).

Nothing else is downloaded and nothing is added to `PATH`: the plugin ships one
bundled Node script (`plugins/gate/scripts/gate.mjs`, built by `npm run
build:cli`) and finds it through `${CLAUDE_PLUGIN_ROOT}`. It can be used on its
own:

```bash
gate list                       # your team's workflows, and what each needs
gate repo <id> /path/to/clone   # where this machine keeps a repository a workflow pins
gate agents                     # the agents behind them
gate show <id>                  # a definition as it is on the server
gate run dev "…"                # run it here, in this repository
gate status                     # your team's recent runs, and where each ran
gate cancel <execution-id>      # ask one to stop, wherever it is running
gate pull                       # refresh the mirror by hand (every command does it anyway)
gate push <file…>               # save designed definitions to your team (needs an author key)
gate reset                      # disconnect this machine and clear what it pulled
gate version                    # what this build is
```

What travels where:

- **Definitions come down.** `gate pull` mirrors your team's agents and
  workflows into `~/.gate/cache/<team>/`, keyed by a hash the server answers
  `304` for, so every command re-syncs for nothing when nothing changed. The
  mirror is read-only in the sense that matters: it is *replaced* on the next
  pull, so definitions stay the team's, edited in the dashboard.
- **Model calls go up.** Every call goes to `<gate>/api/gateway` on your own
  key, carrying `x-gate-session: workflow:<execution-id>`. Routing, effort,
  prompt caching, the account pool, budget, throttling and the traffic log all
  apply exactly as they do for a run on the server. (In a session-driven run
  that holds as long as your Claude Code points at gate — the dashboard's
  one-click client setup is what does that.)
- **Progress goes up.** Steps and events are batched to `/api/v1/executions/…`
  about once a second, so `/executions/<id>` animates a run on your laptop the
  same way it animates one of its own, and the history is in the same table.
- **The work stays here.** The worktree is on your disk, on its own branch, from
  *your* HEAD — so `/gate:run` is safe to start mid-task, and the diff is
  something you can review with `git` immediately. It is uploaded once when the
  run ends, so the dashboard can show what it did.

A workflow that pins a **connected repository** (`workspace: {repo: ulak-desktop}`)
names an id the server resolves to a checkout it manages — which is not on your
machine. `gate repo ulak-desktop ~/Projects/ulak-desktop` says once which of
your clones it means; without it the run refuses and says so rather than
guessing at a directory. The connected repo's *prepare* commands (`npm ci` and
the like, run in each worktree) are still the server's — a local run does not
get them yet, so a pipeline that relies on them wants a `command` node of its
own.

**Keeping up to date.** Three things move at different speeds, and only one of
them needs anybody to do anything.

- *Definitions* look after themselves. There is no daemon and nothing to push:
  every command — `list`, `run`, `agents`, `show` — sends the mirror's hash as
  `If-None-Match` before doing anything else. Unchanged is a `304` with no
  body; changed is the whole bundle written over the mirror, with anything the
  server no longer has pruned. So a workflow edited in the dashboard is live on
  every machine at that machine's next command, a deleted one disappears, and a
  run can never use a definition older than the moment it started. Being
  offline falls back to the mirror with a note saying when it was pulled.
- *The server* is your deploy. Schema migrations are idempotent on open, and
  the one-time move of `~/.gate/agents` under `teams/default/` happens on the
  first read.
- *The CLI* is `/gate:update`, per machine — it refreshes the marketplace and
  re-installs the plugin, then asks for a restart, because an update is fetched
  at once but loaded at startup. (By hand it is two commands, in order:
  `claude plugin marketplace update gateway`, then `claude plugin update
  gate@gateway` — the second alone re-installs from a marketplace that has not
  been refreshed, which is why the version-skew notes name `/gate:update`.)
  **Anything shipped under `plugins/` or `src/client/` needs a version bump** — installs are cached
  by version (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`), so a
  plugin whose contents changed while its number did not is one `plugin update`
  fetches and then ignores, silently. `npm run build:cli` refuses to build when
  `plugin.json`, the marketplace entry and `GATE_VERSION` disagree — and this is the one
  that can silently drift, so it does not. Every `/api/v1` response carries the
  server's version and the oldest client it will serve (`x-gate-server`,
  `x-gate-min-cli`). A client behind the server says so once and carries on; a
  client below the minimum is refused with `CLIENT_TOO_OLD` and the command
  that fixes it, rather than meeting a route that has moved under it and
  reporting something that reads like a broken workflow. `gate whoami` prints
  both ends. `MIN_CLIENT_VERSION` in `src/lib/protocol.ts` is raised only by a
  change that genuinely breaks older clients — it stops them dead, which is
  the point.

**The run happens in your session, not beside it.** `/gate:run` is the run:
gate says what the next node is and it is done on your machine, in front of
you. Who does it follows the agent's `executor`, the same split the server
makes. An `executor: gate` node is done by your own session, with your tools
and your permissions — you can watch it, interrupt it, and answer it when it
asks, which is what the shipped `acceptance` node does. An
`executor: claude-code` node runs as a spawned Claude Code on your machine
**in the agent's own model** — a planner on GLM, an implementer on a local
model, which your session's model cannot stand in for. `/gate:login` puts
your Claude Code on the gateway as it connects (through the `env` block of
`~/.claude/settings.json`; `gate live` does the same per repository or takes
it out, `gate env` prints it as shell exports) and those nodes run as
**subagents of your session**, drawn live in your terminal the way your own
work is, in the agent's model: gate keeps the team's agents under
`~/.claude/agents/` for that. In a session that is not on the gateway they
run instead as a detached worker that writes what it does to a log; your
session follows it with `gate wait`, relays it, and carries on when the node
is over. Either way those nodes do not ask; the planner's questions travel to
you through the `clarify` node, and the acceptance node asks at the end.

The protocol is four commands, and the session loops them:

```bash
gate begin <workflow> "<task>"          # → the first instruction, as JSON
gate next <execution-id>                # → what to do now (no side effects)
gate step <execution-id> <node> --output-file <file>   # → hand back an answer
gate wait <execution-id>                # → follow a node running in its own model
gate live [--global] [--off]            # → put Claude Code here on the gateway, by its settings
```

`begin`/`step`/`wait` print the next instruction, so the loop is one call per
node. Only **agent** nodes reach the session; `command` nodes are argv from the
workflow file, so gate runs them itself and prints their output to the
terminal. Where the run goes next is still gate's — from the graph's edges and
the outputs handed back, never from the model's judgement — and an answer that
does not match what the agent declared is refused with the reason
(`agent "planner" output invalid — ok: Required`) instead of propagating.

Progress is reconstructed from the run's own steps (`src/client/walk.ts`), because
each command is a new process and the steps are its only memory. That replay is
the same traversal the engine performs and reuses the same edge selection, with
one deliberate difference: a `parallel` node's branches are walked one after
another, since a session can only do one thing at a time. `gate run` still
exists and still runs the engine headlessly — for CI, and for anything with no
session to drive it.

**Stop works in both directions.** The server cannot reach into a process on
your laptop, so Stop on the execution page records the request and the answer
rides back on the run's next report — within a few seconds — where it aborts
the run exactly as a local Ctrl-C would. The reverse is also true: a server
restart no longer kills your run, and a run whose machine goes quiet for fifteen
minutes is settled as `RUN_ABANDONED` rather than claiming to be alive for ever.
**Restart** and **Continue** stay where the worktree is: the execution page
shows the command instead of the buttons.

**The first run of a workflow asks.** A team's `command` nodes and `run_command`
tools now execute on a developer's machine rather than in gate's own sandbox, so
before running a definition this machine has not seen at this exact version, the
CLI lists what it will run and asks. The approval is recorded against the
definition's hash, so an edited workflow asks again; `--yes` skips it for
unattended use.

`/gate:run` alone offers the list; `/gate:run dev fix the flaky test`
starts that one and follows it to the end. A workflow that takes a `repo` input
defaults to the repository you are standing in (`--input repo=…` to aim it
elsewhere).

### Designing a pipeline for a repository

`/gate:design <what it should do>` is the other half: Claude Code reads the
repository it is in — package manager, real test and lint commands, layout,
conventions — and proposes a set of agents and a workflow shaped around what it
found. It is given the authoring reference
(`plugins/gate/reference/authoring.md`) rather than left to guess the file
formats, and it is told to reuse the agents you already have instead of
producing near-duplicates.

It writes the proposal to `.gate-proposal/` and then saves it with `gate push
.gate-proposal/*.md .gate-proposal/*.yaml` — agents before workflows whatever
order you list them in, because a workflow naming an agent the server does not
have yet is refused. That refusal is the point: every push goes through the
same validation the dashboard's editor does, so a wrong definition comes back
as `prompt references undeclared input: nobody.field` or `node "check"
references unknown agent "does-not-exist"` and gets fixed, rather than failing
mid-run. An id that already exists needs `--replace`, so a generated name
cannot quietly overwrite an agent you tuned.

Pushing needs a key with the `author` scope; a key without it is told so
(`SCOPE_MISSING`) rather than being left to wonder. Everyone else on the team
has the new pipeline at their next `gate` command.

## Files

- `src/lib/claude/` — OAuth config, PKCE, token flow, Claude Code identity headers
- `src/lib/router.ts` — context-aware model routing
- `src/lib/accounts.ts` / `account-pool.ts` / `token-manager.ts` — the account pool: sealed token store, selection strategies, cooldowns, per-account refresh
- `src/lib/providers.ts` / `provider-exec.ts` / `anthropic-openai.ts` — non-Claude endpoints in both dialects: the Anthropic↔OpenAI translation, and the Anthropic-dialect forward
- `src/lib/seal.ts` / `store.ts` — AES-256-GCM sealing; the credential shape and the pre-pool file reader
- `src/app/api/gateway/v1/messages/` — the proxy endpoint
- `src/app/api/auth/` — login flow · `src/app/api/accounts/` · `src/app/api/providers/` · `src/app/api/routing/` · `src/app/api/usage/`
- `src/agents/` — agent file format: parse, validate, render · `src/workflows/` — workflow YAML + condition language
- `src/skills/` — the skill library: the `SKILL.md` directory format, the team-scoped registry, git-backed sources with import provenance (`sources.ts`), and how a skill reaches each executor (`inject.ts`)
- `src/runtime/` — the deterministic engine, node executors, agent tools (`tools/`) and per-run worktrees (`workspace.ts`) · `src/providers/` — the `ModelProvider` seam onto the gateway
- `src/executions/` — run history (SQLite) · `src/events/` — the live execution event bus
- `src/lib/teams.ts` / `apikeys.ts` / `tenancy.ts` / `def-root.ts` — people, teams, keys-as-identities, and which directory a team's definitions live in
- `src/app/api/v1/` — the client API: identity, the definition bundle, run registration, progress and stop
- `src/client/` — the CLI that runs a workflow on a developer's machine: the mirror, the HTTP provider onto the gateway, and the reporter · `scripts/build-cli.mjs` bundles it into the plugin
- `plugins/gate/` — the Claude Code plugin: `/gate:run`, `/gate:design`, the authoring reference and the bundled `gate` CLI behind them · `.claude-plugin/marketplace.json` — this repo as a marketplace
