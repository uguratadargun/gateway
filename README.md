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

Everything is configurable from the dashboard (persisted to `~/.gate/settings.json`).

## Files

- `src/lib/claude/` — OAuth config, PKCE, token flow, Claude Code identity headers
- `src/lib/router.ts` — context-aware model routing
- `src/lib/store.ts` / `token-manager.ts` — encrypted token store + refresh
- `src/app/api/gateway/v1/messages/` — the proxy endpoint
- `src/app/api/auth/` — login flow · `src/app/api/routing/` · `src/app/api/usage/`
