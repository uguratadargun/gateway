Status: done
Branch: main
Decisions: docs/decisions/0025-the-autonomous-road-answers-the-planners-questions-itself.md
Design: docs/design/dev-workflow.md

# An autonomous dev road

## Task

Asked: a workflow for gate that runs fully on its own — only the
plan → implement → review cycle, with every decision made by the flow
itself and nobody in the loop.

## Done

- `dev-auto`, a shipped workflow in `src/workflows/defaults.ts`: `dev`'s
  graph from `base` to `planner` and from `implementer` to `merge-request`,
  with `clarify`, `plan-review` and `acceptance` gone. `commit` and
  `staged` continue to `merge-request`; the reviewer's approval is what
  opens it. The verifier, the spec check and the reviewer's routed
  rejections are `dev`'s, with the same give-up edges.
- `decide`, a shipped agent in `src/agents/defaults.ts`, standing in the
  `clarify` node (the id the planner reads answers under): rules on the
  planner's questions from its recommendation, the repository's record and
  memory, never asks, and ends its answers with the sentence that has the
  planner write each ruling into the plan's assumptions. `executor: gate`,
  read tools and `memory_search`, no `asks`.
- Two terminals of the road's own: `never-planned` when the planner is
  still asking after three rounds of answers, and `objection-needs-a-person`
  when the planner objects to another team's decision — an objection is a
  request to another team and this road cannot confirm one; `dev` is where
  that task goes.
- `tests/defaults.test.ts`: the agent's declaration, and the graph under
  stand-ins — no node asks, the questions reach `decide` with the planner's
  notes and the answers reach the planner's next pass, the give-up after
  three rounds, the objection stop, review and verifier loops and their
  give-ups, the merge request after a commit and after an already-committed
  branch.
- `plugins/gate/commands/run.md` lists it among the shipped roads, never
  picked on the person's behalf; `design.md` and `reference/authoring.md`
  describe it; the skills page and `defaults:restore` name it among the
  roads that need no skill.
- `docs/design/dev-workflow.md` describes the road; decision 0025 records
  why the planner is kept and answered rather than replaced.

Run: `npx vitest run tests/defaults.test.ts` (58 passed), `npm run typecheck`,
`npm run docs:check`, `npm test`.
