Status: done
Branch: gate/run-30b9988f
Decisions: docs/decisions/0033-an-input-only-a-guard-reads-is-optional.md
Design: docs/design/agents-and-skills.md, docs/design/workflows-engine.md

# Optional run inputs are discoverable

## Goal

`gate list` tells a person what a workflow needs, and it is only half the
truth: `requiredRunInputs` scans agent nodes' declared `inputs` and their
prompt bodies, so a run input that only an edge guard reads is invisible
everywhere. `dev-auto`'s `deliver` is exactly that — set it to `"branch"` and
the run ends on the commit instead of opening a merge request — and the only
place it is written down is the workflow's `description`.

Make those keys discoverable. Collect the `input.X` references a workflow's
edge guards read, keep them apart from the required ones, and show them in
`gate list`, in `gate show`, and on the dashboard's workflow page, each time
saying they are optional.

Out of scope, and deliberately:

- **`requiredRunInputs` returns exactly what it returns today.** A guard-read
  key becoming required would make the server refuse every existing
  `gate begin dev-auto …` call that omits `deliver` with `RUN_INPUT_MISSING`.
  Nothing in this change may touch that function's result or
  `missingRunInputs`.
- No new YAML syntax. Optional inputs are *derived* from the guards already in
  the file; the workflow schema is untouched.
- No change to the run-start path, the engine, or `dev-auto` itself.
- No change to the `/api/v1/bundle` protocol or the client's cached manifest
  (see Approach for why).

## Approach

**One new function, in the module that already owns the question.**
`src/workflows/inputs.ts` gains `optionalRunInputs`, beside the untouched
`requiredRunInputs`:

```ts
export function optionalRunInputs(wf: WorkflowDefinition, loadAgent: (id: string) => AgentDefinition): string[]
```

It walks every node's `edges`, and for each edge that has a `condition` it
asks `conditionPaths` (already exported from `src/workflows/condition.ts`,
already used by the loader for the same kind of scan) for the dotted paths the
expression reads. A path whose first segment is `input` contributes its second
segment as a key. The result is sorted, and every key that
`requiredRunInputs(wf, loadAgent)` already returns is removed — required and
optional are two disjoint lists, so no surface ever has to say the same key
twice or decide which label wins.

Two seams worth naming:

- **A switched-off node contributes nothing.** `requiredRunInputs` already
  skips `node.disabled`, and for the same reason: a disabled node routes on
  `skipTo`, so its guards are never evaluated and asking for a value nothing
  will read is noise. `optionalRunInputs` skips them the same way.
- **Guards on any node, not just `condition` nodes.** `when` on an agent or
  command node's edge is the same guard read by the same `selectEdge`. The
  scan is over `wf.nodes[].edges[]`, not over `type === "condition"`.

**The CLI computes it locally, from the mirror.** `gate list` reads the
required keys out of the cached `manifest.json`, which is only rewritten when
the bundle hash changes — and that hash is computed from the definition
*sources*, so a gate that starts sending a new manifest field would not reach
a client whose team's definitions have not changed (304, stale manifest kept).
`src/client/cli.ts` already imports `getWorkflow` and `getAgent` and already
runs them against `cacheScope(team)` in `gate agents`, and the mirrored
workflow files are always current. So the CLI parses the mirrored definition
and calls `optionalRunInputs` itself. Nothing is added to the bundle, to
`Manifest`, or to `BundleWorkflow`; there is no protocol version skew to
reason about, and a workflow the mirror cannot parse simply shows no optional
inputs rather than crashing the listing.

The formatting of the `gate list` line moves into one exported pure helper so
the suite can hold it, matching how `parseArgs`/`parseInputs` are exported
from `cli.ts` for `tests/cli-inputs.test.ts`.

**The dashboard reads it from the route that already computes the required
list.** `src/app/api/workflows/[id]/route.ts` returns `requiredInput`; it gains
`optionalInput` beside it, and `/workflows/<id>` names it in the sentence under
the Run input box. The optional keys are *not* pre-filled into the JSON
textarea — pre-filling a key with `""` is how the required ones get asked for,
and doing it to an optional key would put a value into the run that the person
never chose. `/api/workflows` (the list route) and the list page are left
alone: that page does not render inputs today.

**Shipping.** `src/client/cli.ts` changes, so `plugins/gate/scripts/gate.mjs`
has to be rebuilt and `CLAUDE.md`'s rule applies: `plugin.json`,
`marketplace.json` and `GATE_VERSION` bump together.

## Assumptions

- `gate show` prints the summary as YAML comment lines above the source
  (`# required input: …`, `# optional input: …`, each omitted when its list is
  empty, then a blank line, then the definition unchanged). Chosen over
  printing to stderr because the command's whole job is to be read, and over a
  plain-text header because `#` keeps redirected output a valid workflow file.
  Agents get no such header — a `#` in Markdown is a heading, and an agent has
  no run inputs of its own.
- `gate list` omits the optional segment entirely when a workflow has none, so
  the output for every workflow that has none is byte-for-byte what it is
  today.
- The dashboard names the optional keys in the hint sentence only; it does not
  pre-fill them into the Run input textarea.
- A key read by a guard *and* declared by an agent is required, not optional —
  it is subtracted from the optional list.
- The version goes 0.43.0 → 0.44.0 (a feature, and the repository uses the
  minor for features), and the changelog line is released under it with
  `npm run changelog:release`, as commit 855f804 did for 0.43.0, so
  `npm run build:cli` warns about nothing.
- Memory holds no decision about run inputs, `requiredRunInputs`, `gate list`
  or the condition language's `input` root; the recall brief found none and
  `src/workflows/inputs.ts` has never been recorded as touched. Nothing here
  adapts or contradicts a sibling team's decision.

## Baseline

`npm test` (vitest, whole suite) in
`/Users/ugur/.gate/workspaces/30b9988f-6ad0-4e48-866e-a94efcee0eed`.

**Green.** 82 test files (81 passed, 1 skipped — `tests/memory-bench.test.ts`,
skipped by its own guard), 775 tests (774 passed, 1 skipped), 11.5s, exit 0.
Nothing was red before this run started.

`npm run typecheck` and `npm run docs:check` are the other two commands; the
docs check also runs inside `npm test` as `tests/docs-record.test.ts`.

## Documentation

Two design docs describe the feature as it stands and both have a sentence
that stops being true:

- `docs/design/agents-and-skills.md` — the paragraph beginning "A workflow's
  run input is checked before anything starts" (currently: "`/workflows/<id>`
  pre-fills the box with the `input.*` keys its agents read"). Rewrite it so it
  is the present tense of the feature: the keys agents read are required, a run
  missing one is refused with `RUN_INPUT_MISSING`, the keys only an edge guard
  reads are optional — shown beside the required ones in `gate list`,
  `gate show` and on `/workflows/<id>`, never pre-filled and never able to
  refuse a run.
- `docs/design/workflows-engine.md` — a sentence in **How it works**, under the
  paragraph on edge selection, saying that the `input.*` keys a guard reads are
  collected as the workflow's optional run inputs; the **Key files** line for
  `src/workflows/inputs.ts` (today "required run inputs"); one **Pitfalls**
  line — a guard on a switched-off node contributes no optional input, because
  the run takes `skipTo` and never evaluates it; and the new record at the top
  of **Decisions**.

This is a decision: an input a guard reads could have been made required (and
would have broken every existing call), or optional inputs could have been
declared explicitly in a new top-level YAML key instead of derived. The record
is `docs/decisions/0033-an-input-only-a-guard-reads-is-optional.md` — 0033 is
the next free number.

`CHANGELOG.md` gets one line under `## Unreleased`; it is written in Task 4,
where the release moves it under 0.44.0.

---

### Task 1: The keys a workflow's guards read

**Files**
- modify `src/workflows/inputs.ts`
- test `tests/workflows.test.ts` (the existing `describe("run inputs")`)
- test `tests/defaults.test.ts` (the block that holds `dev-auto`'s graph, near
  the terminal-list assertion around line 1782)

**Do**

Add `optionalRunInputs` to `src/workflows/inputs.ts`, with the signature above,
importing `conditionPaths` from `./condition`. It collects, over every node of
`wf` that is not `disabled`, every edge whose `condition` is not null, every
path `conditionPaths` returns for it, the path's second segment where the first
is `"input"`. It then subtracts the whole of `requiredRunInputs(wf, loadAgent)`
and returns the rest sorted.

Give it a doc comment in the module's voice saying why the two lists are
separate: a key a guard reads changes where a run ends, not whether it can
start, and promoting one to required would refuse every existing call that
omits it. Leave `requiredRunInputs` and `missingRunInputs` untouched — the
comment on `requiredRunInputs` still describes exactly what it does.

**Test**

In `tests/workflows.test.ts`, extend `describe("run inputs")` (its `workflow`
helper builds a two-node graph; write a fuller source string where a
`condition` node is needed) with cases asserting:

- a `condition` node's guard `input.deliver == "branch"` puts `deliver` in
  `optionalRunInputs` and leaves `requiredRunInputs` unchanged;
- a guard on an ordinary agent or command node's edge counts the same as one on
  a `condition` node;
- a key an agent declares *and* a guard reads comes back only from
  `requiredRunInputs`, and `optionalRunInputs` is empty;
- `outputs.*` and `visits.*` in a guard contribute nothing;
- a guard on a `disabled` node contributes nothing (mirror the existing "does
  not ask for what only a switched-off step would have read" case).

In `tests/defaults.test.ts`, one assertion on the shipped `dev-auto`: its
`optionalRunInputs` contains `deliver` and its `requiredRunInputs` does not.
That is the case the whole change exists for, and it keeps the shipped
pipeline's guard honest the way decision 0029 keeps its graph honest.

Command: `npx vitest run tests/workflows.test.ts tests/defaults.test.ts`.

**Done when** both files pass, `requiredRunInputs`'s existing assertions are
unchanged and still green, and `npm run typecheck` is clean.

### Task 2: `gate list` and `gate show` say what is optional

**Files**
- modify `src/client/cli.ts`
- test `tests/cli-inputs.test.ts`

**Do**

Export a pure formatter from `cli.ts`, beside `parseArgs`/`parseInputs`:

```ts
export function inputSummary(required: string[], optional: string[]): string
```

It returns `input: <required joined by ", ">`, with `none` when `required` is
empty (that is today's wording, keep it), followed by ` · optional: <optional
joined by ", ">` only when `optional` is non-empty.

In `cmdList`: take the team into a local before syncing (`const team = await
teamOf(client, config); const manifest = await sync(client, team);`), build
`const scope = cacheScope(team)` once, and for each manifest workflow work out
its optional keys from the mirror — `optionalRunInputs(getWorkflow(wf.id,
scope), (id) => getAgent(id, scope))` inside a `try`, falling back to `[]` on a
throw, since a definition the mirror cannot parse must not stop the listing.
Keep reading the required keys from `wf.inputs` as today. The third printed
line becomes `  ${inputSummary(wf.inputs, optional)} · ${wf.nodeCount} nodes ·
${where}`.

In `cmdShow`: keep the manifest sync and the workflow-then-agent fallback as
they are. Before printing a workflow's source, try `getWorkflow(id, scope)`;
when it parses, print `# required input: …` when there are required keys and
`# optional input: …` when there are optional ones, then a blank line, then the
source unchanged. When it throws, print the source alone. The agent branch is
untouched.

Update the `gate show` line in `USAGE` only if its words stop being true; "print
a definition as it is on the server" still is, since the added lines are
comments.

**Test**

In `tests/cli-inputs.test.ts`, a new `describe("what a workflow needs")`:

- `inputSummary(["repo", "task"], ["deliver"])` is
  `'input: repo, task · optional: deliver'`
- `inputSummary(["repo"], [])` is `'input: repo'`
- `inputSummary([], [])` is `'input: none'`
- `inputSummary([], ["deliver"])` is `'input: none · optional: deliver'`

Command: `npx vitest run tests/cli-inputs.test.ts`.

**Done when** those pass, `gate list`'s output for a workflow with no guard-read
inputs is character-for-character what it was, and `npm run typecheck` is clean.

### Task 3: The dashboard's workflow page says it too

**Files**
- modify `src/app/api/workflows/[id]/route.ts`
- modify `src/app/workflows/[id]/page.tsx`

**Do**

In the route's `GET`, add `optionalInput: optionalRunInputs(workflow, (agentId)
=> getAgent(agentId, scope))` beside the existing `requiredInput`.

On the page, add an `optionalInput` state beside `requiredInput`, fill it in
`load()` from `data.optionalInput ?? []`, and leave the pre-fill block that
seeds the textarea from `required` exactly as it is — optional keys are never
seeded. In the hint paragraph under the Run input textarea, after the existing
"This workflow needs …" clause, add a second clause, rendered only when
`optionalInput.length > 0`, naming the keys in the same `font-mono` span and
saying they are optional and read only where the run branches, so leaving them
out never refuses the run.

**Test**

None written here: the suite has no renderer (`environment: "node"`,
`include: ["tests/**/*.test.ts"]`, no testing-library), and the route's new
field is a single call to the function Task 1 covers. `npm run typecheck`
covers the shapes on both sides.

**Done when** `npm run typecheck` is clean, `npm test` is still green, and the
route returns `optionalInput` alongside `requiredInput`.

### Task 4: Ship it — the version, the changelog, the bundled CLI

**Files**
- modify `CHANGELOG.md`
- modify `plugins/gate/.claude-plugin/plugin.json`
- modify `.claude-plugin/marketplace.json`
- modify `src/lib/protocol.ts` (`GATE_VERSION`)
- modify `plugins/gate/scripts/gate.mjs` (regenerated, committed)

**Do**

In this order:

1. Write one line under `## Unreleased` in `CHANGELOG.md`, in the voice the
   other entries use — what changed for the person, not which file moved: a
   workflow's optional run inputs are now listed. Name `dev-auto`'s `deliver`
   as the case, say the keys come from the guards the workflow already has, and
   say that nothing became required, so every existing call still means what it
   meant.
2. Set the version to `0.44.0` in all three places —
   `plugins/gate/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
   and `GATE_VERSION` in `src/lib/protocol.ts`. `build:cli` refuses when they
   disagree.
3. `npm run changelog:release` — moves `Unreleased` under `0.44.0` and leaves
   an empty `## Unreleased`, which `docs:check` requires.
4. `npm run build:cli` — regenerates `plugins/gate/scripts/gate.mjs`. It must
   print no version mismatch and no missing-changelog warning.

Stage the named files explicitly; do not `git add -A`.

**Test** `npm test` (the whole suite, including `tests/docs-record.test.ts`),
and `npm run build:cli` exiting 0 with no warning.

**Done when** the three versions read `0.44.0`, `CHANGELOG.md` has a
`## 0.44.0` section with the new line and an empty `## Unreleased` above it,
the rebuilt `gate.mjs` contains the new `gate list` output, and the suite is
green.

### Task 5: Documentation

**Files**
- modify `docs/design/agents-and-skills.md`
- modify `docs/design/workflows-engine.md`
- create `docs/decisions/0033-an-input-only-a-guard-reads-is-optional.md`

**Do**

Rewrite the two design-doc passages named in `## Documentation` above so each
reads as the present tense of the feature — rewrite the sentences that are no
longer true, never add a paragraph saying what changed. Add the new record to
`docs/design/workflows-engine.md`'s `## Decisions` list, newest first.

Write the decision record with all eight sections, logic and not code:

- **Context** — `requiredRunInputs` scans agent nodes and prompt bodies only;
  `dev-auto`'s `deliver` changes where a run ends and is findable nowhere but
  the workflow's description.
- **Decision** — an `input.*` key that only an edge guard reads is an *optional*
  run input: collected from the guards, listed beside the required ones
  wherever a workflow's inputs are shown, and never able to refuse a run.
- **Rationale** — the two lists answer two different questions. Required
  answers "can this run start"; optional answers "what else can I say to it".
  Deriving optional from the guards means a workflow that gains a guard gains
  its documentation in the same edit.
- **Alternatives** — (a) make guard-read keys required: refuses every existing
  `gate begin dev-auto …` that omits `deliver`, and `RUN_INPUT_MISSING` for a
  key the run does not need is a lie; (b) a new top-level `inputs:` block in the
  workflow schema: a second place to keep in step with the guards, and it would
  go stale the first time a guard changed; (c) leave it to the `description`
  field: what is there today, and it is what this record is fixing.
- **How it works** — the scan over non-disabled nodes' guarded edges, the
  subtraction of the required set, and the three surfaces. Note that the CLI
  computes it from the mirrored definitions rather than from the bundle,
  because the bundle's hash is over sources and an unchanged team answers 304
  with the old manifest.
- **Consequences** — `requiredRunInputs` and `missingRunInputs` are unchanged,
  so the run-start path is untouched; a guard on a switched-off node shows
  nothing; a workflow the mirror cannot parse lists no optional inputs rather
  than failing `gate list`.
- **Touches** — `src/workflows/inputs.ts`, `src/client/cli.ts`,
  `src/app/api/workflows/[id]/route.ts`, `src/app/workflows/[id]/page.tsx`,
  `workflows`, `cli`.
- **Supersedes** — none.

Header block: `Status: accepted`, `Date: 2026-09-21`, `Run: gate/run-30b9988f`.

**Test** none (documentation). `npm run docs:check` must pass, and it also runs
inside `npm test`.

**Done when** both design docs read as the present tense of the feature with no
"what changed" paragraph, every one of the record's eight sections is filled
with logic rather than code, `npm run docs:check` is clean, and the commit that
carries them names them on one line in its body:
`Documents: docs/decisions/0033-an-input-only-a-guard-reads-is-optional.md, docs/design/workflows-engine.md, docs/design/agents-and-skills.md`.
