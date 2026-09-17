# Workflows engine

## Summary

A workflow is a graph of agents, commands and decisions a team writes once
and runs on any task: plan, implement, verify, review, loop back on a failure,
ask the person, open a merge request. The engine walks it deterministically —
a model produces output, the file decides where the run goes next — and shows
the person every choice it made, on the canvas and on the execution page.
Branches that depend only on the same upstream output run at the same time.

## How it works

A workflow lives at `~/.gate/teams/<team>/workflows/<id>.yaml` and is
validated when the file is saved, so a broken workflow never reaches the
engine: unknown agents (in the team's own scope or inherited from the default
team), unreachable nodes, dangling edges, malformed conditions, an `entry`
that does not exist, disabled nodes that skip in a circle, and every
parallel-branch rule below are all rejected with the reason.

Node types are `agent`, `command` (argv, no shell — it runs in the run's
worktree when the workflow has one; an hour's default timeout, `0` for none),
`condition` (routing only, no output), `parallel` and `terminal` (`status:
completed` or `failed`). An `agent` or `command` node can carry `disabled:
true`, which switches the step off without taking it out of the graph: runs
walk straight past it — nothing called, nothing spent, no step recorded, no
visit counted — along one of the node's own edges, named by `skipTo` when it
has more than one. Only nodes that do work can be switched off.

**The engine, never a model, decides where a run goes.** Edge selection is
the only place the next node is chosen, and it is pure data: guarded edges in
declaration order, then the single edge without a `when` as the fallback.
Conditions read `outputs.*`, `input.*` and `visits.*` with
`== != > >= < <= && || !` over literals; they are tokenized, parsed into a
small AST and interpreted — there is no `eval` or `new Function` anywhere in
that path, so an untrusted workflow file cannot execute JavaScript. A
`command` node is spawned from an argv array in the YAML, never a shell
string built from model output. There are no ceilings a workflow file cannot
raise: `maxWorkflowSteps`, `maxVisits` and `maxCostUsd` default to `0`,
none; a loop ends on its own give-up edge (`visits.<node> >= n` → a terminal
naming what is stuck), and a run that is looping is stopped from the
dashboard, where it can be seen looping. Visit counts are cumulative across a
Continue, so a run that hit a declared ceiling halts again at once.

Cancellation is checked before every node and inside an agent's tool loop;
the upstream request is really aborted and a command node's child is killed.
Every model call goes through `executeMessages` in-process, so model
resolution, effort, prompt caching, budget, quota protection and traffic
logging apply exactly as for any other client. A node runs on the model its
agent names, so a node revisited in a loop stays on that model and reuses its
prompt cache.

### Running branches in parallel

Nodes that depend only on the same upstream output can run at the same time:
a `parallel` node starts every branch together and continues at its `join`
node once they have all finished.

```yaml
  - id: checks
    type: parallel
    branches: [reviewer, security]   # started together
    join: verdict                    # both must arrive here

  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict

  - id: security
    type: agent
    agent: security-reviewer
    next: verdict

  - id: verdict            # a normal condition node: both verdicts are readable
    type: condition
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
      - to: implementation
```

Each branch is checked at save time to be a self-contained region: branches
may not overlap, may not be entered from anywhere but the fan-out node, may
not end the workflow, and must reach the join; the fan-out node may not be
reachable from inside its own branches. That is what makes concurrency safe —
two branches can never write the same node output or race for the same edge.
Review and security review, which both read only `implementation.diff`, are
the natural pair; the shipped pipelines keep review as one agent node and
leave the fan-out to `/gate:design` for a project with a second thing to
check every time. If one branch fails, the run fails: the other branches are
allowed to finish unwinding first (their in-flight model call is not
cancelled) so the execution history stays complete. Real upstream
concurrency is still bounded by gate's concurrency limiter.

### Editing the graph

`/workflows/<id>` is an editor, not just a picture. The canvas is
trackpad-first — two fingers pan, pinch zooms, the wheel does not — and the
toolbar adds nodes of any type. Drag from a node's right handle onto another
node to connect them (on a `parallel` node that adds a branch); click an edge
and press Delete to remove it. The inspector on the right edits the selected
node: its id (every reference follows the rename), label, agent, argv,
terminal status, branches and join, and its edges with their `when`
conditions. **Turn off** takes a step out of the run without deleting it —
the card stays, dimmed and marked `off`, and runs walk past it along the edge
the inspector names. The canvas fills most of the page and has a full-screen
mode (Escape leaves it, then the selection); a minimap sits in the corner,
cards snap to the 16px grid the background draws, and **Tidy up** lays
everything out left-to-right again.

Nothing is written until **Save graph**, which posts the graph, serializes it
to YAML server-side and runs it through the same validation a hand-edited
file gets — an unreachable node or an unknown agent comes back as the same
error message, and the file on disk is untouched. Saving from the canvas
rewrites the file, so YAML comments do not survive it; the **YAML** tab is
still there for hand-editing, and refuses to open over unsaved graph edits.
Node positions are stored apart from the definition, so arranging the canvas
never touches the workflow file.

### Seeing the routing

Nothing about where a run goes next is hidden in a model: the engine takes
the first edge whose condition holds, and the last edge without a condition is
the fallback. The UI shows that in three places. On the canvas, edges that
hand control back into a node the run is still inside — `tests failed →
implementation`, `changes requested → implementation` — leave from a handle of
their own under the card and travel back on a dashed amber return lane, one
lane per loop, so they never double back through the forward flow. The
**Routing** card beside it lists every point where the engine chooses, in
words. The inspector's *arrives from* section answers the same question from
the other end: what leads into this node, and under what condition.

On `/executions/<id>` each step carries the decision that followed it, so a
finished run reads as the path it actually took (`tester → checks · tests
pass`, `verdict → implementation · changes requested`). Parallel branches
interleave in the step list, so the link out of a step is matched against the
definition rather than its neighbour, and the last decision — into a terminal
node, which never runs as a step — is recovered from how the run ended.

## File format

```yaml
name: Sample dev pipeline
entry: planner
maxWorkflowSteps: 0      # no ceilings: loops end on their own give-up edges
maxVisits: 0             # (visits.<node> >= n → a terminal naming what is stuck)
nodes:
  - id: planner
    type: agent
    agent: planner
    next: implementation

  - id: tester
    type: agent
    agent: tester
    edges:
      - when: outputs.tester.passed == true
        to: reviewer
        label: tests pass
      - to: implementation        # no `when` → the fallback edge
        label: tests failed

  - id: done
    type: terminal
```

Top level: `name`, `description`, `entry`, `workspace` (`repo`, `baseRef`,
`branchPrefix`; an empty `workspace: {}` makes `repo` a run input),
`maxWorkflowSteps`, `maxVisits`, `maxCostUsd` (all default `0`, none), and
`nodes` (1–100). A node has `id` (`[a-z0-9-]`, up to 64), optional `label`,
and `next` (one unconditional edge) or `edges` (up to 20: `to`, optional
`when` and `label`). `agent` adds `agent` and an optional `inputs` override;
`command` adds `command` (argv), `cwd`, `timeoutMs`; both take `disabled` and
`skipTo`. `parallel` has `branches` (2–10) and `join` instead of edges;
`terminal` has `status`. Unknown keys are rejected.

## Key files

- `src/workflows/types.ts`, `src/workflows/loader.ts` — the schema, `skipTargetOf`, `successorsOf`; parsing, structural checks, the parallel-region rules
- `src/workflows/condition.ts` — the condition tokenizer, parser and interpreter
- `src/workflows/registry.ts` — the file store per scope, validated against that scope's agents
- `src/workflows/serialize.ts`, `graph-view.ts`, `routing.ts` — graph → canonical YAML for **Save graph**; what the canvas draws, which links loop back, what a transition was
- `src/workflows/inputs.ts`, `src/workflows/snapshot.ts`, `src/workflows/usage.ts` — required run inputs, the definitions a run is frozen to, which workflows name each agent
- `src/workflows/defaults.ts` — the shipped `dev`, `dev-super` and `dev-quick` pipelines
- `src/runtime/engine.ts` — the walk: entry to terminal, parallel fan-out and join, cancellation, resume
- `src/runtime/executors/condition.ts` — `selectEdge`, the one place the next node is chosen; `agent.ts`, `claude-code.ts`, `command.ts` beside it are the node executors
- `src/runtime/state.ts`, `src/runtime/errors.ts` — outputs, visit counts, step records; the typed failure codes
- `src/runtime/workspace.ts`, `src/runtime/tools/` — the per-run worktree, the workspace tools and path confinement

## Pitfalls

- An edge with no `when` is the fallback, and there is exactly one per node. Two unguarded edges are a validation error; a node whose guarded edges all fail and has no fallback ends the run with `WORKFLOW_ROUTING_ERROR`.
- A `condition` node produces no output; a condition that reads `outputs.<conditionNode>.x` is always undefined.
- A branch may not be pointed at from outside its fan-out node, and may not contain a terminal. Adding `next: done` inside a branch is refused with the branch named.
- Saving from the canvas discards YAML comments. Keep hand-written commentary in `description` or in the labels.
- A workflow saved without `workspace` gives its agents no tools at all; they reason over what the graph hands them and nothing else.

## Decisions

- [0009 — A run is judged by the definitions it started with](../decisions/0009-a-run-is-judged-by-the-definitions-it-started-with.md)
- [0001 — The engine routes, never a model](../decisions/0001-the-engine-routes-never-a-model.md)
