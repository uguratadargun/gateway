# 0015. The gateway resolves names, never difficulty

Status: accepted
Date: 2026-09-16
Run: remove-difficulty-routing

## Context

gate shipped with a difficulty router. Every request was classified from its shape — estimated prompt tokens, whether tools were present, `max_tokens`, and keyword lists checked against the last user message — into one of six categories, and each category named a tier and an effort level. A Haiku judge graded the ambiguous middle on a 1–5 rubric. Sticky sessions existed to stop the result from thrashing, and a throttle downgraded a tier as an account's window filled. The product's one-sentence pitch was that gate picks the model.

Three things were true at once, and together they settle it.

The mechanism's inputs are measured to be poor. A production router built on the same signals we used — length, question words, keywords — scored 38.4% against a 20% uniform-random baseline, sent zero correct predictions to two of its five classes, and graded *below* the trivial "always use one strategy" baseline. Prompt length is near-worthless as a difficulty proxy: permutation importance 0.012 for character length, 0.024 for token count, both beaten by a one-bit "contains digits" flag at 0.031.

Rule-based routing is measured to cost more than not routing. On TwinRouterBench's dynamic track, a rule-based router spent $172.56 and resolved 73 of 100, against $54.73 and 74 of 100 for the unrouted frontier model. Only a trained, execution-verified router beat the baseline. Ours was rule-based.

And it damages the larger lever. Prompt caches are model-scoped with no escape hatch, so moving a live conversation between models rebuilds the whole prefix — the lever that is worth 2.5× to 3.7× on agent loops. Anthropic's guidance puts model selection last, after every lever that does not constrain the intelligence ceiling, and names routers directly as a cause of silently dropped reasoning: a model that cannot read a prior turn's thinking block has it removed from the request with no error and no billing signal.

Meanwhile the information the heuristics tried to infer was already declared upstream, by something better placed to know it. Every shipped agent names its model. Claude Code names its own, and already sends its background traffic to Haiku by itself.

## Decision

gate resolves the model name a caller asked for; it never infers which model should answer. A request names a provider model, a concrete `claude-*` id, or a tier alias. Anything else — `auto` included — is a 400 that says what to do instead.

## Rationale

A caller that names a model has made a choice, and gate is not better placed to overrule it. The agent file, the `/model` command and the workflow definition are where that choice belongs, because each of them knows the task; a gateway sees one request body and a keyword list.

Rejecting an unresolvable name rather than defaulting is the same principle one step further. A silent default puts a conversation on a model nobody chose, and the person only finds out from the bill or from an answer that is worse than they expected. An error names the problem at the moment it is introduced.

Effort stays, and becomes the only lever gate turns. It is ahead of model choice in the measured order, it does not move a conversation between cache namespaces, and a client that sets its own is still never overridden.

Sticky sessions and the throttle downgrade go because their reason for existing goes. Stickiness was a brake on a mechanism that no longer moves; the throttle downgrade was the one remaining path that changed a model mid-conversation for a reason other than failure, and it is exactly the case Anthropic's warning describes.

## Alternatives

Keep the difficulty table but default it off. The dead code still has to be maintained and documented, the dashboard still has to explain six categories, and the feature still reads as a recommendation. A switch nobody should turn on is not a feature.

Keep `auto` and map it to a configured default model. It would spare the machines already wired for `auto` an error. It also keeps a name in the product whose meaning silently changed from "gate decides" to "gate's default", which is the kind of quiet reinterpretation that outlives the people who remember it. `applyClaudeCode` repairs those machines on the next login instead.

Replace the heuristics with a trained classifier. This is the one shape measured to work, and the cost is a training set, an eval harness, shadow validation and a retraining cadence per model release — to win back a lever that sits last in the order and fights the first one. Not now, and not without an eval.

Route only subagent traffic, leaving the main conversation pinned. A genuine middle ground: a subagent's first call has no cache to break. It still guesses at a model the caller could simply have named, and `CLAUDE_CODE_SUBAGENT_MODEL` already lets a person declare it in one line.

Keep the throttle downgrade, since a cheaper tier beats a refusal. Rotating accounts already covers the case the downgrade was for, and a downgrade that silently drops the reasoning behind pending tool calls is worse than a 429 that says the window is full.

## How it works

`routeModel` tries four things in order and stops at the first that answers. A `provider:<name>/<model>` reference wins outright. A concrete `claude-*` id passes through untouched, with any `[1m]` window marker stripped first. An alias is looked up in a name table and resolves to a tier's configured model, or to whatever concrete id the table points at. Anything left over raises `UnresolvedModelError`, which the gateway turns into a 400 naming the three forms that work and telling a caller still wired for `auto` to re-run `/gate:login`.

`routing.json` narrows to three keys: `tiers`, `aliases`, and `default`. `default` decides nothing about which model answers — it names the tier an unrecognised provider model counts as, which is what selects its fallback chain. A file written before 0.39 keeps its old keys on disk; the loader reads only the three it still uses, so an upgrade needs no migration and no edit.

Two things still change a model after resolution, and both are rescues from a hard failure rather than choices: the tier fallback chain on a 429 or 529, and the retry that splices Sonnet in when Haiku refuses an oversized prompt. Both carry the silent-reasoning-drop risk described above. They are kept because the alternative is a failed request, not a cheaper one.

The token estimate survives as a reported number on `x-gate-tokens-est` and nothing more. No threshold reads it.

## Consequences

A client that sends a model gate cannot resolve now fails instead of being served something. Machines connected before 0.39 carry `ANTHROPIC_MODEL=auto` and will get that 400 until they reconnect; `applyClaudeCode` strips the stale key, the picker row and the context-window override on the next login, so `/gate:login` is the whole repair.

gate no longer has an opinion about cost per request. Spend is now shaped by which model an agent names and by the default effort — both declared, both visible in a file. Anything that wants gate to choose again needs a trained router and an eval, and reverses this record.

`sessions.base_tier` and `sessions.effort` stay in the schema, written by nothing and read by nothing. The `grades` table is gone from the schema; an existing database keeps an orphaned empty copy.

The dashboard's routing section is one card. The six-category table, the three switches and the simulator are gone, which makes the example in 0013 stale without making its decision wrong.

## Touches

- `src/lib/router.ts`
- `src/lib/gateway-core.ts`
- `src/lib/clients.ts`
- `src/lib/settings.ts`
- `src/lib/schemas.ts`
- `src/lib/usage.ts`
- `src/components/routing-rules-panel.tsx`
- `src/app/api/routing/route.ts`
- routing
- gateway

## Supersedes

none
