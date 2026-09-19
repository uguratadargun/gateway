# 0020. A provider model reaches the picker under its own name

Status: accepted
Date: 2026-09-17
Run: provider-models-in-the-model-picker

## Context

0015 settled that gate serves the model a caller names. It left a gap on the
other side of that sentence: a person cannot name what nothing has told them
about. A provider model has always been addressable — `provider:zai/glm-5.3`
wins the first step of resolution — but Claude Code's `/model` picker lists
Claude models and nothing else, so the reference has to be typed from memory
or not at all. A gate with two providers connected was, to everyone but the
person who configured it, a gate with none.

Claude Code publishes a gateway protocol for exactly this. With
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` it calls `GET /v1/models` on
the base URL at startup and adds what it finds to the picker, reading `id`,
`display_name` and `description` from each entry. gate has served that
endpoint all along. But the client keeps only the entries whose `id` contains
`claude` or `anthropic`, case-insensitively, and ignores the rest — a filter
that every `provider:` reference fails by construction. Discovery alone can
never surface GLM or a model on the developer's own network.

The same client takes a written lineup: `modelPicker`, whose rows it validates
as `{ model, label?, description?, behavesAs? }`. `behavesAs` is the field
that makes a row work rather than merely appear — without it the client
answers that the id "isn't described by this version's model catalog". The
setting is read from the user or managed scope only; a project file carrying
one is ignored silently.

## Decision

gate writes the provider models into Claude Code's `/model` picker as rows
naming themselves, and turns the client's own discovery on beside them. The
id in the row is the same `provider:<name>/<model>` reference the gateway
resolves, so the name the person picks is the name gate is asked for.

Which model answers a person's request stays the person's choice. gate does
not give anyone a per-person tier table, and does not point a tier at a
provider on anybody's behalf.

## Rationale

A picker row is a statement of what is available, not a decision about what
runs — which is the line 0015 drew. The person still picks, and what they
pick travels to the gateway unchanged: `x-gate-model`, the traffic log and
the usage row all name the model that actually answered.

The alternative shape was available and is the one to say no to explicitly.
The caller's identity already reaches `executeMessages`, so gate could hold a
tier table per person and resolve `sonnet` to GLM for one of them. That is
the same sentence 0015 refused, moved from the request's shape to the
caller's name: the person asks for one model and another answers, and nothing
in their session says so. A row that reads `glm-5.3-flash (zai)` cannot lie
about which model it is.

Discovery is turned on because it is the client's own mechanism for the half
gate cannot write: the connected account's Claude models, named by the gate
that will actually serve them. It costs one 3-second request at startup,
against the gateway the session is already pointed at.

Connecting a machine now names no model at all. `applyClaudeCode` used to
write `ANTHROPIC_SMALL_FAST_MODEL=haiku`, which sent Claude Code's background
traffic through the gate's `tiers` table; the variable is deprecated by the
client and nothing replaces it. Writing the current spelling instead was
considered and dropped: it would make `tiers.haiku` decide what answers when
a person picks Haiku, which is the same gap between the name asked for and
the model that answers that this record refuses two paragraphs above — and
the traffic it would have moved is documented by Anthropic as "typically
under $0.04 per session". A person who wants their background traffic on a
local model writes one line in their own settings.

## Alternatives

Serve the provider models under ids that pass the discovery filter, and let
the client discover them. It is one string change and no new settings key.
It also means a model called something containing `claude` that is not a
Claude model, written into a cache file on every developer's machine. The
filter is the client's protection against a shared key surfacing everything
it can reach; dressing up as Claude to get past it is a lie told to a
safeguard.

A per-person tier table on the server. Works for every client, Cursor and
Codex included, and needs no file on anybody's machine. Rejected above: it
reintroduces the gap between the name asked for and the model that answers,
this time with no request-shaped heuristic to blame it on.

`ANTHROPIC_CUSTOM_MODEL_OPTION`. Three environment variables, no new settings
key, and no schema to track. It carries exactly one model. Two providers were
already one too many.

Write the rows into the project's `settings.local.json`, where `gate live`
already writes the gateway variables. Claude Code ignores `modelPicker`
outside the user scope, so it would have written a file that did nothing. The
rows go to `~/.claude/settings.json` even when the variables did not.

Leave it as documentation: tell people to type `/model provider:zai/glm-5.3`.
It is what happens today, and what makes a connected provider invisible.

## How it works

`providerCatalogue()` in `src/lib/providers.ts` is the one list: every enabled
provider's models, declared or discovered, each as `{ id, display_name,
description }` — the name carrying the provider, because two of them may
serve the same model id, and the description saying whether the endpoint is
on your network or remote. `/v1/models` serves it, so a client discovering
models sees the same names gate would have written.

`src/lib/model-picker.ts` turns those entries into rows and merges them into
a settings object: gate's own rows replaced each time, everybody else's kept
and kept first, `replaceBuiltInOptions` never written. It holds no database
handle, because both sides use it — the gate from its own tables through
`applyClaudeCode`, and the CLI on a developer's machine from what
`GateClient.providerModels()` read off the gateway.

`gate live` and `gate login` write the rows to the user's settings and the
variables wherever they were going anyway; `gate live --off` and `gate reset`
take both out. A gateway that cannot be reached costs the rows and not the
connection.

## Consequences

`/model` lists the provider models under their own names, after the built-in
rows. Picking one sends `provider:<name>/<model>` to the gate, which resolves
it on the first step, skips the account pool, and puts nothing on the
Anthropic bill.

Every row borrows Sonnet's client-side profile through `behavesAs`, including
its context window. A provider model with a smaller window is compacted later
than it should be, and the correction — `CLAUDE_CODE_MAX_CONTEXT_TOKENS` —
only applies to an id the client does not recognise, which `behavesAs` has
just made it recognise. A small-window local model still needs naming by hand.

`ANTHROPIC_SMALL_FAST_MODEL`, which `applyClaudeCode` wrote until now, is
deprecated by the client and is removed on the next connect rather than left
to be read by a version that no longer honours it. With it goes the last
place gate named a model on a person's behalf: the settings a connect writes
now carry the gateway, the key and the discovery flag, and no model.

Background traffic from a connected machine names a concrete Claude model
again, so `tiers.haiku` no longer reaches it. Nothing that asked for a Claude
account stops asking for one.

Every session started by a connected machine calls `/v1/models` on the gate
once at startup.

## Touches

- `src/lib/model-picker.ts`
- `src/lib/providers.ts`
- `src/lib/clients.ts`
- `src/app/api/gateway/v1/models/route.ts`
- `src/client/live.ts`
- `src/client/cli.ts`
- `src/client/api.ts`
- routing
- providers

## Supersedes

none
