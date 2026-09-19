# Working in this repository

Read `docs/ARCHITECTURE.md` before touching code: it is the map. The design
doc of the feature you are changing is under `docs/design/`; read it next.

## The record — what goes where, and when it is required

This repository keeps its own record in four places. Every change keeps
them true; a change that does not is not finished. The forms are in
`plugins/gate/reference/docs.md`.

| You did | You must |
| --- | --- |
| Changed behaviour a design doc describes | Rewrite the sentence in `docs/design/<feature>.md` so it is true now. Never add "what changed"; the doc is the present tense. |
| Built something no design doc covers | Create `docs/design/<feature>.md`: Summary, How it works, Key files, Pitfalls, Decisions. |
| Made a real choice, or reversed an earlier one | Write `docs/decisions/NNNN-<slug>.md`, next free number, all eight sections: Context, Decision, Rationale, Alternatives, How it works, Consequences, Touches, Supersedes. Logic, not code. |
| Reversed a recorded decision | Add `Status: superseded by NNNN` to the old record. Change nothing else in it — ever. |
| Finished a task | Write `docs/specs/YYYY-MM-DD-<topic>.md`: Status, Branch, Decisions, Design lines, then what was asked and what counted as done. |
| Changed what the product does | One line under `## Unreleased` in `CHANGELOG.md`. |

Not required: a decision record for a bug fix that follows the existing
design, a design doc for a refactor that changed no behaviour, a spec for a
change you did not make.

`docs/plans/` is the pipeline's scratch space and is gitignored. Nothing
under it is the record.

A commit whose change touched the record names the files in its body, on
one line: `Documents: docs/decisions/0007-x.md, docs/design/sync.md`. That
line is how a reader gets from `git blame` to the reasoning.

## Commands

- `npm test` — vitest, the whole suite. `npx vitest run tests/<file>` for one.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run docs:check` — the record's form: decision numbers, sections,
  links, spec headers. The same check runs inside `npm test`.
- `npm run build:cli` — bundles the plugin CLI; refuses when the three
  version numbers disagree, warns when the plugin changed without a bump or
  the changelog has no entry for the version.
- `npm run changelog:release` — moves `Unreleased` under `GATE_VERSION`.
- `npm run defaults:restore -- --refresh` — rewrites a live gate's shipped
  agents and workflows from `src/agents/defaults.ts` and
  `src/workflows/defaults.ts`; needed after those files change.

## Commits

Subject in the repo's form: `feat(area): what changed, as a sentence`,
`fix(area): …`, `docs: …`. The body says why. No trailers of any kind — no
`Co-Authored-By`, no `Generated with`. Anything shipped under `plugins/` or
`src/client/` needs a version bump in `plugin.json`, `marketplace.json` and
`GATE_VERSION` together.

## Rules that hold everywhere here

- The engine routes, never a model: a workflow's next node is decided by
  the YAML's edges, not by an agent's text.
- No run ceilings: no `maxCostUsd`, `maxVisits` or `maxWorkflowSteps` above
  zero in a shipped workflow. Loops end on give-up edges that land on a
  terminal saying what is stuck.
- Shipped agents are named, never copied: a project-specific step is a
  command node or the task text, not a second planner.
