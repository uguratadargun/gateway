# 0033. An input only a guard reads is optional

Status: accepted
Date: 2026-09-21
Run: gate/run-30b9988f

## Context

`requiredRunInputs` scans agent nodes: their declared `inputs` and the
`input.*` placeholders in their prompts. That is how `/workflows/<id>`
pre-fills the run-input box and how a run is refused up front with
`RUN_INPUT_MISSING` instead of dying on its first node.

An edge guard reads `input.*` too, and none of that is collected anywhere.
`dev-auto`'s `deliver` is the case that exposed it: set it to `"branch"`
and the run stops at the commit instead of opening a merge request
(decision 0032), and the only place that is written down is the
workflow's `description` — read only by a person picking a road in
`/gate:run`, and not shown by `gate list`, `gate show`, or the dashboard's
workflow page. A team that adds a second such guard to a workflow of its
own has the identical problem with no record at all.

## Decision

An `input.*` key that only an edge guard reads is an *optional* run
input: collected from the guards already in the file, listed beside the
required ones wherever a workflow's inputs are shown, and never able to
refuse a run. Required and optional are disjoint — a key an agent also
declares is required, not optional, so no surface ever has to decide
which label wins for the same key.

## Rationale

Required and optional answer two different questions. Required answers
"can this run start"; optional answers "what else can I say to it before
it does". Keeping them apart, rather than merging them into one list a
caller has to interpret, means neither surface has to explain the
difference in words — the required list is exactly what refuses a run,
and the optional one never does.

Deriving the optional list from the guards, rather than asking anyone to
maintain it, means a workflow that gains a guard gains its documentation
in the same edit that added the guard. There is nothing to remember to
update and nothing that can go stale on its own.

## Alternatives

**Make a guard-read key required.** Refuses every existing
`gate begin dev-auto …` call that omits `deliver` with
`RUN_INPUT_MISSING`, for a key the run does not need unless it reaches
that fork. A refusal that says a value is missing when the run would have
gone just fine without it is a lie the tool would be telling.

**A new top-level `inputs:` (or similar) block in the workflow schema,
declared by hand.** A second place that has to be kept in step with the
guards a workflow actually has, and it goes stale the first time someone
edits a `when` expression without remembering the declaration beside it.
Derivation has no such gap because there is only one place to look.

**Leave it in the `description` field.** What the workflow already does
today, and it is the gap this record exists to close: prose a person
reads only if they open the workflow and find the field, never surfaced
by any of the three places a workflow's inputs are otherwise shown.

## How it works

The scan walks every node in the workflow that is not `disabled`, and
every edge on it that carries a guard. For each guard, it asks the
condition language what dotted paths the expression reads and keeps the
second segment of every path whose first segment is `input`. That set,
minus everything `requiredRunInputs` already returns for the same
workflow, sorted, is the optional list. A guard on any node counts —
agent, command or `condition` — because the engine chooses the next node
the same way regardless of which kind of node the guard sits on.

Three surfaces show it. `gate list` prints it after the required keys on
the same line, omitted entirely when it is empty so a workflow with no
such guard prints exactly what it always has. `gate show` prints it as a
`# optional input: …` comment above the source, the same way it prints
the required keys, so redirecting the output still yields a valid
workflow file. `/workflows/<id>` names the keys in the sentence under the
Run input box, but never seeds them into the JSON textarea the way a
required key is seeded — putting a value into the pre-filled JSON is how
a required key is asked for, and doing that to an optional one would put
a value into the run the person never chose.

The CLI computes the list itself from the mirrored workflow and agent
definitions on disk, rather than reading it off the bundle the way it
reads the required list: the bundle's hash is computed from the
definition sources, so a team whose definitions have not changed gets a
304 and keeps its old cached manifest, and a new field on the bundle
would never reach a client in that state. The mirror is always current,
so the CLI parses it directly and falls back to an empty optional list
if a workflow the mirror holds does not parse, rather than failing the
whole listing over one broken definition.

## Consequences

`requiredRunInputs` and `missingRunInputs` return exactly what they
returned before this change, so the run-start path — what refuses a run,
and with what message — is untouched. A guard on a switched-off node
contributes nothing, because a disabled node routes on `skipTo` and its
guards are never evaluated; asking for a value nothing will read would be
noise. A workflow the CLI's mirror cannot parse lists no optional inputs
rather than crashing `gate list`.

## Touches

- `src/workflows/inputs.ts`
- `src/client/cli.ts`
- `src/app/api/workflows/[id]/route.ts`
- `src/app/workflows/[id]/page.tsx`
- `workflows`, `cli`

## Supersedes

none.
