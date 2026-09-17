# Gateway pipeline

## Summary

Every model call that reaches gate — from Claude Code, an SDK, an OpenAI
client, or a workflow node running in-process — goes through one pipeline: it
is authenticated, resolved to a model, trimmed, cached where it can be, held to a
concurrency ceiling, sent upstream with retries and fallbacks, and then
accounted for in usage, spend, the traffic log and the live activity feed. A
person sees the outcome as response headers on the call and as dashboards
afterwards; a workflow sees it as budget.

## How it works

The native endpoint is `POST /api/gateway/v1/messages`. `/v1/chat/completions`
and `/v1/responses` translate an OpenAI-shaped request into that body first
and translate the answer back; `/v1/models`, `/v1/messages/count_tokens` and
`/v1/messages/batches/*` are proxied on the account. A workflow node calls
`executeMessages` directly, in-process, with the same options — not an HTTP
round trip back to itself.

**Auth.** The bearer token (`Authorization` or `x-api-key`) is resolved to a
principal: an issued key with the `gateway` scope when any key exists, else
`GATE_API_KEY`, else — when neither is configured — nobody in particular,
which is what a loopback-only install has always been. A revoked key, or a
disabled person's key, stops resolving at once. The last two cases have no
person attached and answer as the default team. The principal is carried
through the pipeline rather than reduced to a yes at the door: it rides on the
dispatch options as four scalars — key, person, team, scopes — because a
streamed reply is accounted for after the request object is gone, and the
traffic log names whoever made the call.

**Session.** The conversation is identified from `x-gate-session` or
`x-claude-code-session-id`, or from a fingerprint of the system prompt and
first user message, so that cost can be grouped per session on `/sessions`.

**Compression.** With `compression.enabled` (off by default), oversized text
blocks are trimmed to `maxBlockChars` (20 000) and exact-duplicate adjacent
blocks dropped before anything else reads the body.

**Model resolution.** The name the caller sent is resolved to an endpoint — a
provider reference, a concrete `claude-*` id, or a tier alias — and a name that
resolves to none of those is a 400. gate never substitutes a model the caller
did not name. Effort is then written onto the body, capability-aware, unless
the client set its own. See `routing.md`.

**Account and throttle.** For a Claude model the pool picks an account by the
configured strategy (see `account-pool.md`). The throttle then reads that
account's 5h utilization: at `throttle.blockAt` (0.98) the account is skipped
and the next one tried. It never changes the model — a cheaper tier on a live
conversation costs more than it saves. When
none is left the request is refused with a 429 that says it is gate's, not
Anthropic's, names how many accounts it tried, and carries a `Retry-After`
from the window reset. A provider model skips this step entirely.

**Prompt cache.** With `promptCache.enabled` (on by default), `cache_control`
breakpoints are placed on the last block of the system prompt, the last tool,
and the last turn of the conversation so far, so the next turn hits
Anthropic's prompt cache; the `1h` TTL adds the `extended-cache-ttl-2025-04-11`
beta. Breakpoints the client already placed are never overridden.

**Budget.** Spend today and this month are SQL sums over usage. Past
`budget.dailyUsd` or `budget.monthlyUsd` a `block` budget answers 402; a
`warn` budget lets the call through with `x-gate-budget: exceeded`.

**Response cache.** A non-streaming request with no temperature (or zero) is
deterministic, and with `cache.enabled` its key — model, system, messages,
tools, `max_tokens`, `temperature`, `top_p` — is looked up before anything is
sent. A hit answers from SQLite with `x-gate-cache: hit`, records a usage
event with reason `cache hit`, and spends nothing upstream; a miss is marked
`x-gate-cache: miss` and stored on a 200 for `cache.ttlSeconds` (3600), with
the store capped at 500 entries. Independently of the cache setting, identical
deterministic non-stream requests already in flight are **coalesced**: later
callers share the first one's result rather than spending quota again, which
is what a client retry storm turns into.

**Concurrency.** At most `concurrency.maxInFlight` (4) upstream requests run
at once; the rest wait in FIFO order up to `queueTimeoutMs` (60 000) and
then get a 503 with `Retry-After: 5`. This protects the account from bursts —
parallel subagents, parallel workflow branches — that trip rate limits.

**Upstream.** The request is sent on the chosen account in the Claude Code
request shape, with the body sanitised for the concrete model it is going to.
A 401 forces a token refresh and one resend. Network errors, 5xx and 529 are
retried with backoff up to `retry.maxRetries` (2). A 429 is waited out when
its `Retry-After` is under `retry.maxRateLimitWaitMs` (5 000); otherwise an
account-wide 429 parks the account and the pool supplies the next one on the
same model, and a model-specific 429 or a 529 walks the tier's fallback chain
(`fallback.chains`, on by default) to a cheaper model. A 400 for an oversized
prompt on Haiku inserts Sonnet into the chain. Every reply's
`anthropic-ratelimit-*` headers are captured onto the account row and into
the global snapshot the forecast reads. A provider model takes the same
retries against its endpoint and the same chain when it is down.

**Response.** The upstream body streams back to the client as it arrives; a
tee feeds the accounting after the response is sent. The headers set on the
way out are `x-gate-model`, `x-gate-tier`, `x-gate-route-reason`,
`x-gate-tokens-est`, and when they apply `x-gate-fallback`,
`x-gate-budget`, `x-gate-session`, `x-gate-account`,
`x-gate-provider`, `x-gate-cache`.

**Accounting.** Once the body is complete its usage block is parsed —
input, output, cache-read and cache-creation tokens — and priced at Anthropic
list rates per tier (Haiku 1/5, Sonnet 2/10, Opus 5/25, Fable 10/50 USD per
million in/out), cache reads at 10 % of input (2.5 % on Fable 5.1), cache
writes at 1.25× for the 5m TTL and 2× for 1h, and a provider model at zero. A
usage event, a traffic-log row (previews truncated to 2000 characters, 500
rows kept, local only) and an activity event for the SSE live tail on
`/traffic` are written, and the concurrency slot is released. The traffic row
names the key, the person and the team that called, and the account or the
provider that served — as ids, which `/traffic` resolves to names as it reads,
so a renamed account reads as it is now and a deleted one still reads. A
workflow node calling in-process names itself `workflow`; a gate with no key
issued and none configured names itself `local`. `/analytics`,
`/sessions` and the CSV/JSON exports are `GROUP BY`s over the usage table, so
a budget check stays O(1) in request count.

```
request ─ auth ─ session ─ compress ─ resolve ─ account+throttle ─ prompt-cache ─ budget
        ─ response-cache? ─ limiter ─ upstream (retry · rotate · fallback) ─ headers
        ─ stream to client ─┬─ usage · traffic · activity · cache store
```

## Key files

- `src/lib/gateway-core.ts` — `dispatch` (the ordered pipeline), `sendWithFallback`, `attemptOnAccount`, `attemptOnProvider`, `executeMessages` (adds response cache and coalescing), `parseUsage`
- `src/lib/gate-auth.ts` — `gatePrincipal`: issued key, `GATE_API_KEY`, or open on loopback
- `src/lib/compress.ts` — block trimming and adjacent-duplicate removal
- `src/lib/prompt-cache.ts` — `cache_control` breakpoints on system, tools and last turn
- `src/lib/budget.ts` — daily and monthly caps, `warn` or `block`
- `src/lib/cache.ts` — the response cache: key material, TTL, 500-entry cap, hit/miss counters
- `src/lib/inflight.ts` — coalescing of identical in-flight requests
- `src/lib/limiter.ts` — the process-wide semaphore with FIFO queue and timeout
- `src/lib/ratelimit.ts` — the global rate-limit snapshot, history and time-to-limit forecast
- `src/lib/usage.ts` — usage events, session routes, spend aggregation
- `src/lib/pricing.ts` — list prices, cache multipliers, savings vs. Opus
- `src/lib/traffic.ts` — the local request/response log
- `src/lib/activity.ts` — the SSE activity feed
- `src/lib/settings.ts` — every key named above, persisted to `~/.gate/settings.json`
- `src/app/api/gateway/v1/**` — the endpoints
- `src/providers/gate-provider.ts` — the in-process entry a workflow node uses

## Pitfalls

- The response cache and coalescing only apply to non-streaming requests with no temperature or temperature 0. Claude Code streams, so it never hits either.
- A `warn` budget never refuses anything; only `block` does. The header is the only sign.
- The limiter is per process. Two gate processes on one account have twice the ceiling.
- Usage for a streamed reply is written after the response finishes, via `after()`. A request that is cut off mid-stream leaves no usage row, and the concurrency slot is held until the tee drains.
- Costs are API-list equivalents. On a subscription the real cost is flat; the numbers are for comparison, not an invoice.
- A fallback changes the model after resolution; `x-gate-model` is what was actually used, `x-gate-route-reason` is how the requested name resolved.
- Compression is lossy by design (blocks are trimmed) and off by default. Turning it on changes prompts and therefore prompt-cache hits.
- The traffic log holds served exchanges, not every call. A response-cache hit, a refusal (400, 401, 402, 429, 503) and the proxied `/v1/models`, `count_tokens` and `batches/*` write no row at all, so counting callers there under-counts them — the throttle's 429s, the ones a question about quota is usually about, are exactly what is missing. `from_cache` is written false for the same reason.
- A traffic row is best-effort: the insert swallows its errors so a log line can never fail a served request, which also means a missing row is silent.

## Decisions

- [0017 — The traffic log names who called and who served](../decisions/0017-the-traffic-log-names-who-called-and-who-served.md)
