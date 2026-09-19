Status: done
Branch: main
Decisions: docs/decisions/0020-a-provider-model-reaches-the-picker-under-its-own-name.md
Design: docs/design/providers.md ("The rows in Claude Code's /model", key files, pitfalls), docs/design/routing.md (how it works, pitfalls)

# The providers a gate serves are pickable in a normal Claude Code session

## Goal

A gate with Z.AI and a vLLM box connected served three provider models and
told nobody. `/model provider:zai/glm-5.3` always worked; nothing listed it, so
only the person who had configured the provider could use it. The ask was to
make a normal Claude Code session — the kind a team member starts, not a
pipeline node — able to pick GLM or the local model from the picker.

Done when `/model` lists every model this gate's providers serve, picking one
sends that provider reference to the gate, and the built-in Claude rows are
still there.

Out of scope: per-person routing on the server, and any mapping that makes
`sonnet` mean something other than Sonnet. 0020 rules both out.

## Approach

Claude Code's own gateway discovery was the obvious route and is a dead end for
this: it reads `/v1/models` but keeps only ids containing `claude` or
`anthropic`, which no `provider:` reference does. It is turned on anyway, for
the half it does cover — the connected account's models — and the rows for the
provider models are written into `modelPicker` instead.

The row shape was taken from the installed client rather than from the docs,
whose `modelPicker` section is truncated in every published form: the binary
validates `{ model, label?, description?, behavesAs? }` and, separately,
`replaceBuiltInOptions` as a boolean. Its own error message names `behavesAs`
as the cure for an id that "isn't described by this version's model catalog",
which is what every provider reference is.

One catalogue feeds both readers. `providerCatalogue()` names each model
`<model> (<provider>)` — two providers may serve the same id — and describes it
by where the endpoint is. `/v1/models` serves that as `display_name` and
`description`, the two optional fields discovery reads, so the names match
whether a row was written by gate or found by the client.

`src/lib/model-picker.ts` holds the row shape and the merge and touches no
database, because both sides use it: the gate writes rows from its own tables,
and the CLI on a developer's machine writes the same rows from what it read off
`/v1/models`. Rows somebody else put in the lineup are kept and kept first, and
`replaceBuiltInOptions` is left alone — true would take the Claude rows away.

The rows go to `~/.claude/settings.json` even when `gate live` put the gateway
variables in the repository's `settings.local.json`: the client reads
`modelPicker` from the user scope only, so the project file would have been
written and ignored.

One variable went and none replaced it. `applyClaudeCode` wrote
`ANTHROPIC_SMALL_FAST_MODEL=haiku`, which the client deprecated; the current
spelling was written in its place and then taken out again. Sending Claude
Code's background traffic through the gate's `tiers` would let `tiers.haiku`
decide what answers when somebody picks Haiku — the same name-versus-model gap
0020 refuses elsewhere — and Anthropic documents that traffic as "typically
under $0.04 per session", so the feature was not worth the exception. A person
who wants it writes the variable in their own settings.

## What was verified

Six tests in `tests/live-settings.test.ts`: the row a catalogue entry becomes,
the fallback to the id when the catalogue named nothing, foreign rows kept
first, gate's own rows replaced rather than duplicated (the pre-0.30 `local:`
spelling included), `replaceBuiltInOptions` untouched, an empty lineup removed
rather than left behind, and the discovery flag added and taken out again with
no model variable beside it.

The catalogue was read off the running gate: `zai` declares `glm-5.3` and
`glm-5.3-flash`, `vllm` discovers `Qwen3.8-27B` from its own endpoint. Those
are the three rows this writes.

Not verified: the rows rendering in a live `/model`. The schema is the
installed binary's own, and the merge is tested, but nobody has watched the
picker draw them.
