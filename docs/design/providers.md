# Providers

## Summary

A provider is any model endpoint that is not one of the connected Claude
accounts: Ollama, vLLM, LM Studio or llama.cpp on the person's own machine, or
a hosted service like Z.AI. Once added, its models appear as
`provider:<name>/<model>` in every model picker — a tier slot, an agent, a
client naming one directly, and Claude Code's own `/model` on every machine
connected to this gate — and a request that lands on one is still routed,
logged and counted the same as a Claude call, while putting nothing on the
Anthropic bill.

## How it works

A provider is added under **Providers** on the dashboard (there are one-click
presets) with a name, a base URL, an optional API key, an optional model list,
and a dialect. The key is sealed under `GATE_SECRET` and never returned by the
API — the dashboard sees only whether one is set. The dialect is the only real
choice:

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
tool arguments streamed as `input_json_delta`. `stream_options.include_usage`
is requested on every stream, because without it most OpenAI-compatible
servers report no usage at all and the request would be accounted as zero
tokens. The translated response carries the `provider:<name>/<model>`
reference as its model, so everything downstream — usage parsing, the traffic
log, the response cache — keeps speaking Anthropic and cannot tell which
upstream served it.

An `anthropic-compat` provider skips all of that. The body is forwarded with
the model id swapped and the provider's key attached, and the answer — JSON or
SSE — is handed back byte for byte. Tool blocks, cache breakpoints and streamed
thinking reach the model exactly as the client wrote them. Only the parameters
that are Anthropic's alone are stripped, because a third-party endpoint answers
400 on them and they arrive constantly: `output_config`, `context_management`,
and any `thinking` type other than `enabled` or `disabled` — which is to say
`adaptive` (Claude Code sends the last two on every request).

The reference form is `provider:<name>/<model>`; the model half may itself
contain slashes (`provider:ollama/library/qwen3:8b`), so only the first one
separates them. The prefix used to be `local:`, which was never true of a
hosted endpoint. Both parse, forever: a `routing.json` or an agent written
before the rename keeps resolving, and is canonicalised to `provider:` on the
way through. Which tier a provider model counts as is whichever tier slot it
was configured into, and `routing.json`'s `default` when it is in none — that is
what the fallback chain uses.

Whether the traffic leaves the network is a separate fact from the dialect.
An endpoint on loopback, RFC1918, a link-local address, a bare container
hostname, or a `.local` / `.internal` / `.lan` name is labelled *on your
network*; anything routable publicly, Z.AI included, is labelled *remote*.

A provider's model list is either declared or discovered. Filled in, the list
the person wrote *is* the catalogue and nothing is probed. Left empty, gate
asks the endpoint's own catalogue — `{baseUrl}/models` with a bearer token for
`openai-compat`, `{baseUrl}/v1/models` with `x-api-key` for
`anthropic-compat` — cached for a minute, and reports a failure as
*unreachable* rather than throwing, so the person can name the models by hand
instead.

`providerCatalogue()` puts every enabled provider's list together, each model
named `<model> (<provider>)` and described by where the endpoint is. That one
list is what `/v1/models` serves and what the rows in Claude Code's `/model`
picker are built from, so a person sees the same names wherever they look. A
provider that is off contributes nothing rather than emptying the list.

### The rows in Claude Code's `/model`

Claude Code lists Claude models. It will also read a gateway's `/v1/models` at
startup — connecting a machine sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
for it — but it keeps only the entries whose id contains `claude` or
`anthropic`, and a `provider:` reference never does. So gate writes those rows
itself, into `modelPicker` in the user's own settings:

```json
{ "model": "provider:zai/glm-5.3-flash", "label": "glm-5.3-flash (zai)",
  "description": "zai · remote", "behavesAs": "claude-sonnet-5" }
```

`behavesAs` is what makes the row work: it hands an id the client has never
heard of the client-side profile of one it knows — context window, effort
defaults — and without it the client says the model "isn't described by this
version's model catalog". Picking the row sends `provider:zai/glm-5.3-flash`
to the gate, so the name the person chose is the name that is resolved, logged
and counted.

The rows are written by `applyClaudeCode` on the gate's own machine and by
`gate live` / `gate login` on everybody else's, both through
`src/lib/model-picker.ts`. Rows somebody else put there are kept, and kept
first; `replaceBuiltInOptions` is never written, so the built-in Claude rows
stay.

### Example: Z.AI (GLM)

Z.AI publishes a Messages API endpoint, which is what makes it worth
forwarding to untranslated. Add it as:

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
discover, so gate would otherwise have nothing to put in the pickers.

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
that node end to end. The child also gets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so telemetry is not served by a
model somebody pays per token for, and a long `API_TIMEOUT_MS`, because
provider endpoints are routinely slower to first token than Anthropic's. (The
child logs one `unrecognized_model` line for a model id it does not know; it
sends the request regardless.)

Practical notes:

- A provider model **costs nothing on the Anthropic bill** — whatever it may
  cost on its own — and usage accounting prices it at zero rather than as the
  tier it stands in.
- If the endpoint is down, or the provider is disabled or missing, the tier
  fallback chain takes over — an unplugged Ollama drops to the next tier
  rather than failing the request. Transient 5xx and network errors are
  retried with backoff first.
- A request to a provider model needs no Claude account at all; the account
  pool and throttle are skipped for it.
- `count_tokens` is never asked for a provider model — Anthropic cannot count
  for a model it does not serve — so the reported token count is the local estimate.
- You can also address one directly, without putting it in a tier:
  `model: "provider:ollama/qwen3-coder"`.

## Key files

- `src/lib/providers.ts` — the provider rows, the two dialects, `parseProviderRef` / `formatProviderRef` / `canonicalModelRef`, self-hosted detection, declared-or-discovered catalogue, and `providerCatalogue()` behind both `/v1/models` and the picker
- `src/lib/model-picker.ts` — the `modelPicker` row shape and the merge, database-free so the CLI bundles it · `src/client/live.ts` writes the rows on a developer's machine, `src/lib/clients.ts` on the gate's own
- `src/lib/provider-exec.ts` — `sendToOpenAIProvider` (translate out and back) and `sendToAnthropicProvider` (forward, strip Anthropic-only fields)
- `src/lib/anthropic-openai.ts` — Anthropic Messages → OpenAI Chat Completions and back, JSON and SSE
- `src/lib/openai-compat.ts` — the inverse direction: OpenAI SDK clients calling `/v1/chat/completions`
- `src/lib/openai-responses.ts` — OpenAI Responses API ↔ Anthropic for `/v1/responses`; stateless, no `previous_response_id`
- `src/lib/gateway-core.ts` — `attemptOnProvider` and the `sendWithFallback` branch that skips the account pool for a provider model
- `src/lib/router.ts` — an explicit provider reference wins the route; a provider model's tier is the slot it sits in
- `src/lib/usage.ts`, `src/lib/count-tokens.ts` — zero pricing and no `count_tokens` for provider models
- `src/runtime/executors/claude-code.ts` — `providerModelEnv`, the alias pinning for a spawned Claude Code
- `src/providers/` — the runtime's own `ModelProvider` interface; not the same thing as a configured endpoint. `gate-provider.ts` is the in-process path a workflow node takes into `executeMessages`

## Pitfalls

- An `anthropic-compat` endpoint with an empty Models field shows nothing in the pickers, because there is no catalogue to discover. Write the list.
- A picker row is written when a machine connects, not when a provider changes. Adding or removing a model shows up in `/model` after the next `gate live` (or `/gate:login`), and after the Claude Code session is restarted.
- Every row borrows Sonnet's context window through `behavesAs`. A local model with a smaller one is compacted late, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` does not correct it — that variable only applies to an id the client does not recognise.
- `openai-compat` drops thinking blocks on the way out; an agent that relies on visible reasoning across turns will not get it from a translated provider.
- Streaming through `openai-compat` reports zero tokens if the server ignores `stream_options.include_usage`; the request still succeeds, it is just unmetered.
- A provider model in a tier slot inherits that slot's fallback chain. `tiers.haiku` on an Ollama that is off means every trivial request drops to Sonnet on a Claude account until it is back.
- The `provider:` reference names an endpoint, it is not a bypass: budget, concurrency, traffic logging and the response cache all still apply.
- The header comment in `providers.ts` still describes the `local:` spelling; the code canonicalises to `provider:`.

## Decisions

- [0020 — A provider model reaches the picker under its own name](../decisions/0020-a-provider-model-reaches-the-picker-under-its-own-name.md)
