# 0032. The autonomous road can stop at the commit

Status: accepted
Date: 2026-09-21
Run: manual

## Context

`dev-auto` ends by pushing the branch and opening a merge request; decision
0025 settled that the reviewer's approval is what opens it, because there
is no person in the loop to approve anything else.

There is a case that does not fit, and it turned up the first time the road
was used in anger: the person starting the run wants the work done and
reviewed, and wants to push it themselves. In the measured run the
instruction was "do it, but do not open a pull request — I will push". The
only way to honour it was to move the git remote out of the way so that
`merge-request` would fail. It worked, and the run ended on `not-shipped`,
a terminal whose status is `failed` and whose label said the branch was
never pushed. Both halves of that are wrong about what happened: the work
was planned, built, verified and approved, and the only thing that did not
happen was a delivery nobody wanted.

The same mislabelling was there for the real failure case. A push that
fails because `gh` is not signed in, or a remote that rejects, also lands
on `not-shipped` — with everything up to the commit intact and a label
implying the run came to nothing.

## Decision

`dev-auto` gains a `delivery` condition node between the commit and the
push, reading the run input `deliver`:

- unset, or anything else — `merge-request`, exactly as before;
- `"branch"` — the terminal `committed`, whose status is `completed`.

`committed` says the work is on the branch and the merge request is the
person's to open. `not-shipped` keeps its `failed` status and is relabelled
to say what is true when it is reached: reviewed and committed on the
branch, the push or the merge request failed.

## Rationale

The run input is the right place for this because it is the only thing the
person says before an autonomous run starts. Adding a gate node to ask
would put a person back in the loop, which is the one thing this road does
not have.

`deliver` does not become a required input, and that is not an accident of
implementation but the reason this shape was chosen. `requiredRunInputs`
scans agent nodes' declared inputs and their prompt bodies; a value read
only by a condition's guard expression is never required. So every existing
`gate begin dev-auto "<task>"` call keeps working and keeps meaning what it
meant, and the new behaviour is reachable only by asking for it.

`committed` is `completed` rather than a new status because it is a
finished run. The pipeline did everything it was asked to do. A third
status — "completed, but less" — would have to be understood by the
dashboard, the recorder, `resume.ts` and everything that reads a run's
outcome, to express something the terminal's label already says.

Relabelling `not-shipped` costs nothing and is worth doing on its own: a
terminal's label is what the person reads when a run ends, and one that
implies a whole run failed when a commit is sitting on the branch sends
them looking for work that is already there.

## Alternatives

**Sabotage the remote.** What was actually done in the measured run: remove
`origin`, let `merge-request` fail, put it back. It leaves the repository
in a broken state for as long as the run takes, it reports a failure, and
it is a trick rather than a feature — the next person has to be told it.

**A `dev-auto-branch` workflow.** A fourth `dev-*` road that is `dev-auto`
minus two nodes. The repository already carries the cost of `dev-auto`
being a literal held to `dev`'s shape by a test (0029); a second literal
held to `dev-auto`'s shape is the same cost again for one edge.

**Make it an agent's decision.** The reviewer, or a new agent, judging
whether to push. The engine routes, never a model — and this is not a
judgement, it is something the person already knows before the run starts.

**Always stop at the commit and let the person push.** That is `dev` with
the gates removed, and it throws away the thing `dev-auto` is for: a task
handed over at the end of the day and read back as a merge request.

## How it works

In `src/workflows/defaults.ts`, `dev-auto`'s `staged` and `commit` nodes
now route to `delivery` where they routed to `merge-request`. `delivery` is
a `condition` node with one guarded edge, `input.deliver == "branch"`, to
`committed`, and a default edge to `merge-request`. `committed` is a
terminal with `status: completed`.

`input` is one of the three roots the condition language allows
(`src/workflows/condition.ts`, validated in `loader.ts`), so the guard is
checked when the workflow is loaded, not at run time. A run started without
`deliver` evaluates the guard against `undefined`, which is not `"branch"`,
and takes the default edge.

The workflow's description says how to ask for it, because the description
is what `/gate:run` shows when a person picks a road.

Two tests in `tests/defaults.test.ts` walk the graph both ways: one begins
with `deliver: "branch"` and asserts the run ends on `committed` with
status `completed` and that no push ran, and one begins without it and
asserts the merge request is reached. The graph-shape test that holds
`dev-auto` to `dev` lists `delivery` and `committed` among the ids this
road adds, with the reason `dev` needs neither.

## Consequences

A person who wants to push themselves says so in the run input and gets a
completed run with a reviewed commit on the branch. Nothing has to be
broken to arrange it.

A push that genuinely fails is still a failed run, and now says which part
failed. Someone reading `not-shipped` knows the commit is there.

`deliver` is a run input with no schema and no validation beyond the one
comparison — a typo means the default road, which is the safe direction to
be wrong in. It is documented in the workflow's description and in
`docs/design/dev-workflow.md`, and nowhere else can it be discovered.

`dev` and `dev-quick` do not get this gate. They have a person at
`acceptance` who can already say stop, and holding there is what
`awaiting-approval` is for.

## Touches

- `src/workflows/defaults.ts`
- `tests/defaults.test.ts`
- `docs/design/dev-workflow.md`

## Supersedes

none. It extends 0025, which stands: with no `deliver` given, the
reviewer's approval is still what opens the merge request, and that is
still the road every existing call takes.
