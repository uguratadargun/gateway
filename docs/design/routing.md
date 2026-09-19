# Routing

## Summary

Any Anthropic-compatible tool pointed at gate names the model it wants — a
Claude model, a tier alias, or a model one of your providers serves — and gate
serves that model. It does not pick one for you: the tool, the agent file or
the person at the keyboard already made that choice, and gate is not better
placed to overrule it. What gate decides is everything around the model: which
connected account serves the call, how hard it thinks when the client did not
say, and where to go when the answer is a rate limit.

## How it works

A client is pointed at the gateway base URL and otherwise left alone:

```bash
# Claude Code — pick your model with /model as usual
ANTHROPIC_BASE_URL=http://localhost:4141/api/gateway claude

# Anthropic SDK
new Anthropic({ baseURL: "http://localhost:4141/api/gateway", apiKey: "unused" })
```

OpenAI SDK clients work too — point them at the same base URL and call
`/v1/chat/completions` (translated to and from Anthropic, streaming included),
or `/v1/responses` for Codex CLI and the newer SDKs. `/v1/models` lists the
four tier aliases, then what the connected account can actually use, then every
provider model — fetched live from Anthropic and falling back to a known list
when the fetch fails. A provider model is listed under a `display_name` that
names its provider and a `description` saying whether the endpoint is on your
network or remote, which are the two optional fields Claude Code's own
discovery reads.

Claude Code is told what this gate serves rather than left to guess.
Connecting a machine sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and
the client asks `/v1/models` at startup and adds what it finds to `/model` — but
it keeps only the entries whose id contains `claude` or `anthropic`, so no
provider model ever reaches the picker that way. Those rows gate writes itself,
into `modelPicker` in the user's own settings, one per provider model, under
the name the catalogue gave it. → `decisions/0020-…`

A name is resolved by trying four things in order and stopping at the first
that answers:

1. An explicit `provider:<name>/<model>` reference wins outright — the caller
   named an endpoint, and there is no ladder to second-guess it with.
2. A concrete `claude-*` id passes through untouched. A trailing `[1m]`, which
   Claude Code appends to mark a 1M window, is not part of the id and is
   stripped first.
3. An alias resolves through a name table: the four tier names, plus
   OpenAI-style names so OpenAI clients work (`gpt-4o-mini` → haiku, `gpt-4o` →
   sonnet, `o3` → fable, and so on; keys are case-insensitive). A tier resolves
   to whatever concrete model that tier is pointed at, a provider model
   included.
4. Anything left over is a **400** that names the three forms that work.

There is no fifth step. `auto` is not a model, and a name gate cannot resolve
is an error rather than an invitation to guess — a silent default would put a
conversation on a model nobody chose, and the person would find out from the
bill. A machine connected before 0.39 still carries `ANTHROPIC_MODEL=auto`;
the 400 says to re-run `/gate:login`, which strips it.

Every response carries `x-gate-model`, `x-gate-tier` and `x-gate-route-reason`;
`x-gate-tokens-est` reports the prompt size, `x-gate-fallback` appears as
`opus->sonnet` when a failure moved the call to another tier, and
`x-gate-account` / `x-gate-provider` name what served it.

**Effort** is the one cost lever gate still turns, and it is the right one: it
sits ahead of model choice in Anthropic's measured order, and unlike a model
swap it does not move a conversation into a different prompt-cache namespace.
The precedence is the `x-gate-effort` request header, then
`reasoning.defaultEffort` in settings — and never over a client's own setting:
a body that already carries `thinking` or `output_config.effort` is left
exactly as sent, because Claude Code sends its own and changing it
mid-conversation would break its prompt cache. When gate raises effort to
`high` or above it also lifts a small `max_tokens` to 8192, since thinking
counts against the ceiling.

Effort is applied capability-aware. Adaptive-thinking models (Fable, Opus 5,
Sonnet 5, and the 4.6–4.8 line) take `output_config.effort`; extended-only
models (Haiku 4.5, Sonnet 4.5) take a `thinking` budget instead, and reject the
effort parameter outright. Whatever the client sent is translated to what the
*target* model accepts — a `thinking: adaptive` block is dropped for Haiku, a
`budget_tokens` block becomes an effort for Claude 5 — so a model reached
through a fallback does not answer 400.

Two things still change the model after it is resolved, and both are rescues
from a hard failure rather than choices: the tier fallback chain on a 429 or
529, and the retry that splices Sonnet in when Haiku refuses an oversized
prompt. Both cross a cache boundary, and a model that cannot read the previous
turn's thinking block has it dropped silently — accepted, because the
alternative is a failed request rather than a cheaper one.

Everything configurable lives in `~/.gate/routing.json`, merged key by key over
the defaults, and it is three keys: `tiers` (the concrete id behind each tier),
`aliases`, and `default` (which tier an unrecognised provider model counts as,
which is what selects its fallback chain — it decides nothing about which model
answers). The dashboard writes the same file and resets the in-process cache; a
hand edit takes effect on restart. A file written before 0.39 keeps its old
difficulty keys on disk; the loader reads only the three it uses, so an upgrade
needs no migration.

## Key files

- `src/lib/router.ts` — name resolution, the alias table, `routing.json` loading, `UnresolvedModelError`
- `src/lib/reasoning.ts` — effort precedence, capability detection per model, `applyReasoning` and `sanitizeForModel`
- `src/lib/models.ts` — the model catalogue behind `/v1/models`, live from Anthropic with a known-list fallback
- `src/lib/gateway-core.ts` — `dispatch` resolves the name, applies effort, picks an account, and sets the `x-gate-*` headers
- `src/lib/clients.ts` — the connect snippets, the picker rows and the variables written with them, and the login-time repair that clears a pre-0.39 `auto`
- `src/lib/model-picker.ts` — the `modelPicker` row shape and the merge that keeps everybody else's rows; `src/client/live.ts` writes the same rows from a developer's machine
- `src/components/routing-rules-panel.tsx` — the dashboard card: the model behind each tier
- `src/app/api/gateway/v1/messages/route.ts`, `.../chat/completions/route.ts`, `.../responses/route.ts`, `.../models/route.ts` — the endpoints that read `x-gate-effort` and hand the body to `dispatch`

## Pitfalls

- Leaving effort unset is not neutral: the API default is `high`. `reasoning.defaultEffort: default` sends nothing and pays for high.
- A client that sets its own `thinking` or `output_config.effort` is never overridden — `x-gate-effort` and the settings default are ignored for it. Claude Code is such a client, so the effort lever does not reach it; set effort in Claude Code itself.
- `model: "auto"` is a 400, not a default. A machine connected before 0.39 keeps sending it until `/gate:login` is run again.
- A tier alias resolves through `tiers`, so pointing `tiers.haiku` at a provider model silently redirects everything that asks for `haiku`, including an agent file that says `model: haiku`.
- `tiers` does not reach Claude Code. It resolves its own aliases before the request leaves, so the gate sees a concrete `claude-*` id and passes it through — background traffic included. Only a client that sends a bare alias, or an `ANTHROPIC_DEFAULT_*_MODEL` a person set themselves, goes through the table.
- `modelPicker` is read from the user or managed scope only. A row written into a project's `.claude/settings.local.json` is ignored without a word, which is why `gate live` writes the rows to `~/.claude/settings.json` even when the gateway variables went into the repository's file.
- A picker row gives a provider model Sonnet's client-side profile through `behavesAs`, its context window included. A local model with a smaller window is compacted late, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` cannot correct it — that variable applies only to an id the client does not recognise, and `behavesAs` has just made it recognise this one.
- Nothing guards Haiku's 200K window before the call. An oversized prompt sent to Haiku is caught only by the 400 → Sonnet retry, after Anthropic refuses it.
- `routing.json` is cached in-process. An edit by hand is not seen until restart; the dashboard's save resets the cache, a `$EDITOR` save does not.
- A fallback still crosses a prompt-cache boundary and can silently drop the previous turn's reasoning. It fires only on a 429/529 or an oversized-prompt 400, but when it fires the conversation continues on another model.

## Decisions

- [0015 — The gateway resolves names, never difficulty](../decisions/0015-the-gateway-resolves-names-never-difficulty.md)
- [0020 — A provider model reaches the picker under its own name](../decisions/0020-a-provider-model-reaches-the-picker-under-its-own-name.md)
