# 0001. The engine routes, never a model

Status: accepted
Date: 2026-09-05
Run: e5c59ad — the commit that introduced the orchestrator; its message is the earliest to state the rule ("the engine — never a model — decides what runs next"). The 0.28.0 release (e1b7604, 2026-09-09) rebuilt the dev pipeline on it, but the decision predates that release.

## Context

gate runs multi-agent pipelines: agents are Markdown files with a prompt, declared inputs and a declared JSON output; workflows are YAML graphs of agent, command, condition, parallel and terminal nodes. Before this was settled, the open question was who decides what happens after a node finishes. The obvious shape is an orchestrator model that reads each result and picks the next step, or agents that talk to each other and hand work along. Both put the control flow inside a model's answer, where it cannot be read before the run, drawn, validated, or explained afterwards.

## Decision

The engine — never a model — decides which node runs next. Routing is data in the workflow definition: each node has edges, each edge may carry a condition over the outputs so far, the engine takes the first edge whose condition holds, and the last edge without a condition is the fallback. A model produces an output; it does not choose a path.

## Rationale

A model can say what it found — `verdict: changes requested`, `replan: true`, `decision: hold` — and the graph says where that leads. Keeping those two apart is what makes a pipeline something a person can hold in their head. The definition is validated when it is saved: unknown agents, dangling edges, unreachable nodes and overlapping parallel regions are refused, so a broken workflow never reaches the engine. The canvas can draw every loop, and a finished run reads as the path it actually took rather than as a transcript to be reconstructed. The condition language is small, tokenized and interpreted; nothing in the routing path is evaluated as code, and nothing in it is a model's judgement.

The same rule sets the boundary for everything built later. When cross-team work was designed (0002), a free message mesh between agents was refused on exactly this ground: it hands routing to the model.

## Alternatives

An orchestrator model that reads each node's result and picks the next node. Refused: the path is then invisible until it is taken, cannot be validated before the run, and cannot be shown on a canvas. Every failure becomes "why did it go there", answerable only by reading a transcript.

Agents that message each other and pass work along (a mesh). Refused for the same reason, with a second cost: the order of work becomes a property of the conversation, not of the definition.

Hard engine-owned ceilings as the way loops end. Not taken as the mechanism: a loop that sends work back until the tests pass is a legitimate run, and a cap of "N visits" cuts it off with everything it spent already gone. Ceilings are declared by the workflow (`maxWorkflowSteps`, `maxVisits`, `maxCostUsd`, 0 meaning none); loops end through the graph — a verdict edge that sends work back and a give-up edge landing on a terminal that says what is stuck.

## How it works

A run walks the graph from the entry node. A node's executor produces an output; the engine evaluates that node's edges in order against the state so far, takes the first whose condition holds, and falls back to the last unconditioned edge. A `parallel` node walks each of its branches at the same time and resumes at the join once all have finished; branches are validated at load time to be disjoint regions, so concurrency never means two nodes racing for the same output. A terminal node ends the run with the status it names.

The routing is shown, not discovered afterwards. On the canvas, edges that hand control back into a node the run is still inside leave from a handle of their own and travel back on a dashed return lane, one lane per loop. The Routing card lists every point where the engine chooses, in words. The inspector's "arrives from" section answers the question from the other end: what leads into this node, and under what condition. On the execution page each step carries the decision that followed it (`tester → checks · tests pass`, `verdict → implementation · changes requested`), and the last decision — into a terminal, which never runs as a step — is recovered from how the run ended.

A model still gets a say, in its output: the reviewer's `replan` names whether a rejection is a bounded fix for the implementer or a fault in the plan for the planner, and the acceptance node does the same with the person's answer. The edge that reads that field is still the definition's, and the person can see it before the run.

## Consequences

Anything that needs a run to go somewhere new needs an edge, not a prompt. Adding a project's own reviewers means wrapping them in a parallel node joining at the verdict and widening the verdict's condition, which is `/gate:design`'s job. A pipeline cannot improvise a step it was not drawn with; when a node needs the person, that is a node in the graph (`clarify`, `plan-review`, `acceptance`), and unattended it holds rather than deciding.

Loops are the workflow's responsibility. A run that turns out to be looping is stopped from the dashboard, where it can be seen looping, rather than by a count the engine imposes. Every loop in a shipped pipeline therefore carries its own give-up edge.

Cross-team collaboration is built as records and short read-only runs (0002, 0003), not as agents addressing each other. A design that needs one model to steer another will run into this record first.

## Touches

- `src/workflows/types.ts`
- `src/runtime/engine.ts`
- `src/runtime/executors/condition.ts`
- `src/workflows/defaults.ts`
- `README.md` (Seeing the routing)
- routing
- engine

## Supersedes

none
