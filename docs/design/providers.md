# Providers

## Summary

A provider is a model endpoint this server can call itself: vLLM, Ollama, LM
Studio or llama.cpp on the gate's own network, or a hosted service like Z.AI.
gate holds no Claude login, so a provider is the only model the server has,
and two things use one: the memory recorder with its consolidation pass, which
read a finished run and write what it decided, and memory's embeddings.
Nothing else does. Every node of a run is the person's own Claude Code, and an
agent cannot name a provider model.

## How it works

A provider is added under **Providers**, in the dashboard's "The server's own
model" section (there are one-click presets), with a name, a base URL, an
optional API key, an optional model list, and a dialect. The key is sealed
under `GATE_SECRET` and never returned by the API — the dashboard sees only
whether one is set. The dialect is the only real choice:

| | `openai-compat` | `anthropic-compat` |
| --- | --- | --- |
| endpoint | `POST {baseUrl}/chat/completions` | `POST {baseUrl}/v1/messages` |
| who | Ollama, vLLM, LM Studio, llama.cpp, most hosted APIs | Z.AI, and anything else that publishes a Messages API |
| what gate does | translates the request out and the answer back | forwards it as it stands |

```
Settings → memory.model = "provider:vllm/<model>"

recorder ──▶ ProviderModelProvider (Anthropic Messages body)
                   │  anthropicToOpenAIRequest
                   ▼
              POST {baseUrl}/chat/completions
                   │  openAIToAnthropicResponse
                   ▼
recorder ◀── Anthropic message
```

### The server's own model call

`ProviderModelProvider` is the one way the server reaches a model. It parses
the reference with `parseProviderRef`, finds the provider with
`getProviderByName`, and refuses one that is missing or switched off with the
place that fixes it; anything that is not a `provider:` reference is refused
with the setting to change. It then hands the body to `sendToProvider`, which
picks the dialect. The call is never streamed: both senders ask for one JSON
answer. A 5xx, a 529 or a connection that did not open is tried twice more,
after about half a second and then a second; any other answer is final. An
aborted call ends as `RUN_CANCELLED`, a failed one as `MODEL_EXECUTION_ERROR`
with the status and the first 300 characters of the body. An answer with no
text is a `MODEL_EXECUTION_ERROR` too: `fromAnthropicMessage` reads only the
text blocks of the Anthropic message that comes back. The result names its
model as the reference it was asked for, not the endpoint's own name for it,
so the ledger says which provider did the work. `apiEquivalentCost` prices that work at zero: it is on
nobody's Anthropic bill, whatever it costs on its own.

The request is plain text chat: a system prompt and user and assistant turns,
with no tools. gate's recorder speaks Anthropic, so the OpenAI translation is
a real round trip, not a passthrough: system blocks are hoisted into a system
message, text blocks cross over, images become data URLs, and thinking
blocks — whose signatures only Anthropic can verify — are dropped. The
answer's text is rebuilt into an Anthropic message with its usage, and its
finish reason becomes `max_tokens` for `length` and `end_turn` otherwise.
OpenAI's `prompt_tokens` counts the cached part of the prompt and
Anthropic's `input_tokens` does not, so the cached tokens are taken out of
`input_tokens` and reported as cache reads, and a cached prompt is not
counted twice.

An `anthropic-compat` provider skips all of that. The body is forwarded with
the model id swapped, the provider's key attached and `ANTHROPIC_VERSION`
sent, and the answer is handed back as it came. Only the parameters that are
Anthropic's alone are stripped, because a third-party endpoint answers 400 on
them: `output_config`, `context_management`, and any `thinking` type other
than `enabled` or `disabled`.

### Where a provider model is named

The reference form is `provider:<name>/<model>`; the model half may itself
contain slashes (`provider:ollama/library/qwen3:8b`), so only the first one
separates them. The older `local:` prefix parses too, and means the same.

It is named in two places, both in Settings → Memory:

- `memory.model`, the recorder's model. It accepts a provider reference and
  nothing else. It is empty by default, and a Claude tier left in an older
  settings file reads as empty. Until it is set, finished runs wait in the
  ledger ([memory](memory.md)).
- `memory.embeddings`, a provider's name and an embedding model. The embedder
  calls `POST {baseUrl}/embeddings` in OpenAI's shape, so the provider must
  answer that. Both empty means search by words alone.

An agent's `model:` is a Claude model. The agent loader refuses a `provider:`
or `local:` reference there, because nothing on the person's machine can
reach it.

### Where it is, and what it serves

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
instead. The panel's refresh button asks again and shows the list, which is
where the name for `memory.model` is read from.

### Example: a vLLM on the gate's network

The intended setup is a vLLM on the gate's own network serving the recorder's
model, and an embedding model for search:

```
Name       vllm
Dialect    OpenAI-compatible
Base URL   http://<host>:<port>/v1
Models     (empty — read from the endpoint)
```

Then, under Settings → Memory, the recorder model is
`provider:vllm/<the served model>` (a Qwen3.8-27B on the live gate), and
embeddings name the provider that serves bge-m3 with `bge-m3` as the model. An
embedding model served by a second vLLM is a second provider.

A hosted endpoint that publishes a Messages API, like Z.AI's
`https://api.z.ai/api/anthropic`, is added as `anthropic-compat`. That
endpoint serves no catalogue, so its models must be written in the Models
field.

## Key files

- `src/lib/providers.ts` — the provider rows, the two dialects, `ANTHROPIC_VERSION`, `parseProviderRef` / `formatProviderRef`, self-hosted detection, and the declared-or-discovered catalogue
- `src/providers/direct-provider.ts` — `ProviderModelProvider`: the server's one model call, its retries and its errors
- `src/providers/anthropic-shape.ts`, `types.ts` — the `ModelProvider` interface, the Anthropic body the recorder hands it, and the text read back out of the answer
- `src/lib/provider-exec.ts` — `sendToProvider`, and behind it `sendToOpenAIProvider` (translate out and back) and `sendToAnthropicProvider` (forward, strip Anthropic-only fields)
- `src/lib/anthropic-openai.ts` — Anthropic Messages → OpenAI Chat Completions and back, for plain text chat
- `src/lib/pricing.ts` — `apiEquivalentCost`, zero for a provider model
- `src/lib/settings.ts` — `memory.model` kept only when it is a provider reference; `memory.embeddings`
- `src/memory/embeddings.ts` — the embedder on a provider's `/embeddings`
- `src/components/providers-panel.tsx`, `src/app/api/providers/` — the panel, and the routes behind it including the model probe

## Pitfalls

- An `anthropic-compat` endpoint with an empty Models field shows no models, because there is no catalogue to discover. Write the list.
- There is no fallback. A provider that is down, switched off or deleted fails the recorder's call; the ledger row is `failed` and retried, and nothing records on any other model meanwhile.
- A recorder model left empty is not an error anywhere but the ledger: finished runs stay `pending` until one is set, and the consolidate button answers 409 with the reason.
- `openai-compat` drops thinking blocks on the way out, and anything but text and images in a message.
- Neither sender streams and neither carries tools. A caller that needs either needs them built here first.

## Decisions

- [0046 — Every person runs on their own Claude login; gate holds no model credentials and serves no models](../decisions/0046-every-person-runs-on-their-own-claude-login.md)
