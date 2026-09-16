# Routing

## Summary

Any Anthropic-compatible tool pointed at gate asks for a model by name, or for
`auto`, and gate decides which Claude tier answers — Haiku, Sonnet, Opus or
Fable — and how hard it should think, from the shape of the request. The
decision is reported back in response headers, so a person can see why a call
went where it went, and the whole mapping can be overridden from the dashboard
or a file. The point is cost: most traffic is utility work that a small model
at low effort answers as well as a large one at high, and the gateway should
be the thing that knows that, not every client.

## How it works

A client is pointed at the gateway base URL and otherwise left alone:

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:4141/api/gateway claude

# Anthropic SDK
new Anthropic({ baseURL: "http://localhost:4141/api/gateway", apiKey: "unused" })
```

OpenAI SDK clients work too — point them at the same base URL and call
`/v1/chat/completions` (translated to and from Anthropic, streaming included),
or `/v1/responses` for Codex CLI and the newer SDKs. `/v1/models` lists what
the connected account can actually use, fetched live from Anthropic and
falling back to a known list when the fetch fails.

Requests to `model: "auto"` are routed by context. Every response carries
`x-gate-model`, `x-gate-tier` and `x-gate-route-reason`; `x-gate-tokens-est`
gives the prompt size the decision was based on, `x-gate-fallback` appears as
`opus->sonnet` when a tier dropped after the decision, `x-gate-throttled` when
the account's window forced a cheaper tier, and `x-gate-account` /
`x-gate-provider` name what served the call.

The route is resolved in a fixed order. An explicit `provider:<name>/<model>`
reference always wins — the caller named an endpoint, and there is no ladder
to second-guess it with. An explicit `claude-*` id passes through unchanged
while `overrideExplicit` is true. An alias (`haiku`, `sonnet`, `opus`,
`fable`, and the OpenAI-style names — `gpt-4o-mini` → haiku, `gpt-4o` →
sonnet, `o3` → fable, and so on; keys are case-insensitive) maps straight to a
tier. Only `auto`, or a name nothing matches, falls through to the heuristics.
A trailing `[1m]`, which Claude Code appends to mark a 1M window, is not part
of the id and is stripped first.

`overrideExplicit` is therefore the switch that decides whether the difficulty
table applies to a client that names its model at all — and Claude Code is such
a client. The dashboard carries it as **Route named models too**, worded the
way a person thinks about it: on, a named `claude-sonnet-5` is graded and sent
to whatever the tier below resolves to, a provider model included; off — the
default — that name is served as asked. The stored flag is the inverse of the
switch, because `overrideExplicit: true` means "an explicit id wins".

The heuristics classify the request into one **difficulty category** from its
shape — the estimated prompt tokens (about four characters each), whether
tools are present, `max_tokens`, and keyword lists checked against the last
user message and against a *short* system prompt only (2000 characters or
less: a title job has a small system prompt, an agent's 30K-token one mentions
everything):

| Category | Fires when |
| --- | --- |
| `background` | no tools and `max_tokens` under 50, or a background keyword |
| `heavy` | a heavy-intent keyword in the user's request |
| `largeContext` | at or above `thresholds.largeContext` (180K) tokens |
| `trivial` | no tools and at or below `thresholds.trivial` (500) tokens |
| `agentic` | tools present |
| `default` | everything else |

Each category maps to a tier and an **effort** level. Effort is the primary
cost lever — the API default is `high`, so *not* setting it is the expensive
choice — and the `balanced` preset follows Anthropic's Sept-2026 guidance:
Haiku at `low` for background and trivial traffic, Sonnet at `medium` as the
daily driver for agentic, default and large-context work, Fable at `high` only
for explicit heavy intent. `economy` keeps everything on Sonnet or below at
`low`; `quality` moves the daily driver up and effort to `high`. Sonnet 5 has
a 1M window at standard pricing, so large context stays on Sonnet; Haiku's
window is 200K, so a prompt over `thresholds.haikuContextMax` (150K) that
would land on Haiku is moved to Sonnet by a hard guard, and a "prompt too
long" 400 from Haiku is retried on Sonnet by the fallback chain.

The ambiguous `default` category gets a second opinion. When the classifier
is enabled and the prompt is at least `classifier.minTokens` (300), one tiny
Haiku call grades the last user message 1–5 on a fixed rubric — RouteLLM's
"LLM judge", with zero training data. Only the query text is sent, clipped
to 4000 characters, and the grade is cached by content hash for a day. The
grade maps 1 → Haiku low, 2 → Haiku medium, 3 → Sonnet medium, 4 → Opus high,
5 → Fable high, shifted one step easier by `economy` and one step harder by
`quality`. The route reason then reads `graded 3/5`.

Effort is applied capability-aware. Adaptive-thinking models (Fable, Opus 5,
Sonnet 5, and the 4.6–4.8 line) take `output_config.effort`; extended-only
models (Haiku 4.5, Sonnet 4.5) take a `thinking` budget instead, and reject
the effort parameter outright. The precedence is the `x-gate-effort` request
header, then the routed category's effort (or the sticky session's), then
`reasoning.defaultEffort` in settings — and never over a client's own
setting: a body that already carries `thinking` or `output_config.effort`
is left exactly as sent, because Claude Code sends its own and changing it
mid-conversation would also break its prompt cache. When gate raises effort
to `high` or above it also lifts a small `max_tokens` to 8192, since thinking
counts against the ceiling. Whatever the client sent is then translated to
what the *target* model accepts — a `thinking: adaptive` block is dropped for
Haiku, a `budget_tokens` block becomes an effort for Claude 5 — so a model
swapped under a client does not answer 400.

**Sticky sessions** keep a conversation where it is. Prompt caches are
per-model and an effort change invalidates them, so within one session gate
never moves *down* a tier and holds the effort it started with; an upgrade
becomes the new baseline. The session is the `x-gate-session` or
`x-claude-code-session-id` header, or a fingerprint of the stable prefix
(system prompt and first user message), combined with a hash of the system
prompt and tool names — so a Claude Code subagent, which shares the session
header but not the system prompt or tools, gets its own baseline rather than
inheriting its parent's tier. Background and heavy traffic are exempt, as is
anything under `sticky.minTokens`.

Everything above is `~/.gate/routing.json`, merged key by key over the
defaults: `tiers` (the concrete id behind each tier), `aliases`,
`thresholds`, `preset`, `classifier`, `sticky`, `heavyKeywords`,
`backgroundKeywords`, `default`, `categories`, `effort` and
`overrideExplicit`. The dashboard writes the same file and resets the
in-process cache; a hand edit takes effect on restart.

## Key files

- `src/lib/router.ts` — the category heuristics, presets, grade mapping, alias table, `routing.json` loading, `cheaperTier`
- `src/lib/reasoning.ts` — effort precedence, capability detection per model, `applyReasoning` and `sanitizeForModel`
- `src/lib/grader.ts` — the Haiku difficulty judge and its content-hash cache
- `src/lib/models.ts` — the model catalogue behind `/v1/models`, live from Anthropic with a known-list fallback
- `src/lib/gateway-core.ts` — `dispatch` applies routing, the grader, stickiness and effort in that order, and sets the `x-gate-*` headers
- `src/lib/usage.ts` — `getSessionRoute` / `setSessionRoute`, the sticky baseline per session
- `src/components/routing-rules-panel.tsx` — the dashboard form: the preset, the six categories, the model behind each tier, and the three switches
- `src/app/api/gateway/v1/messages/route.ts`, `.../chat/completions/route.ts`, `.../responses/route.ts`, `.../models/route.ts` — the endpoints that read `x-gate-effort` and hand the body to `dispatch`

## Pitfalls

- Leaving effort unset is not neutral: the API default is `high`. A category whose effort is `default` sends nothing and pays for high.
- A client that names a concrete `claude-*` model is not routed at all by default: it never reaches the categories, so editing the difficulty table changes nothing for Claude Code until **Route named models too** is on.
- A client that sets its own `thinking` or `output_config.effort` is never overridden — `x-gate-effort` and the category effort are ignored for it. Claude Code is such a client.
- Keyword detection reads the last user message and only a system prompt of 2000 characters or less; a heavy keyword buried in a long agent system prompt does nothing.
- A sticky session never goes down. One heavy request early in a conversation keeps the rest of it on that tier until the session ends; only `background` and `heavy` categories escape.
- `routing.json` is cached in-process. An edit by hand is not seen until restart; the dashboard's save resets the cache, a `$EDITOR` save does not.
- The token estimate is characters divided by four unless `routingPrecision.countTokens` is on, which costs a `count_tokens` round trip per request.
- The grader needs a connected Claude account and spends a few hundred Haiku tokens per uncached prompt; with no account it silently returns no grade and the heuristic category stands.

## Decisions

- none recorded yet
