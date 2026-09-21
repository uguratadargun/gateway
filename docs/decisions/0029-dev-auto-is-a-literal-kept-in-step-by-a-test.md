# 0029. dev-auto is written out, and a test is what keeps it in step with dev

Status: accepted
Date: 2026-09-21

## Context

[0025](0025-the-autonomous-road-answers-the-planners-questions-itself.md)
decided what `dev-auto` is — `dev`'s graph with the three gates removed and
`decide` in the `clarify` node's place — and shipped it. It did not settle
how the graph is *kept* the same as `dev`'s, and that question is now due:
this change adds the record round to `dev`, and it has to be added to
`dev-auto` by hand, which is exactly the moment two graphs drift.

The repository already answers the question once, differently. `dev-super`
is not written out at all: it is `DEV` put through one regex that swaps four
`agent:` lines, so the two cannot drift because there is only one graph. The
question is whether `dev-auto` can be produced the same way.

It was also written twice. `dev-auto` was hand-written into one gate's team
definitions before it was shipped, and that copy drifted: its merge-request
node had grown a GitHub branch its siblings did not have, and its review loop
was `dev`'s from before the record round. Both of those have since been
settled the other way round — GitHub support was added to every pipeline at
once, and the record round is added to both here — which is the pattern this
record is about.

## Decision

`dev-auto` stays a literal in `src/workflows/defaults.ts` — the YAML written
out — and a test is what holds it to `dev`'s shape. It is not derived, and it
is not generated.

## Rationale

Derivation works for `dev-super` because the difference is a pure renaming:
four `agent:` lines, one regex, and nothing else in the file can be affected.
`dev-auto` differs by six nodes removed, two terminals added, four more gone
with the nodes that held for the person, and `plan-check` rewritten. A regex
that performed that would be harder to read than the graph it produced, and
impossible to review — the thing a reader wants to see is the graph.

The other mechanical option, round-tripping `dev` through the YAML parser and
editing the object, destroys every comment in the file. Those comments are
where this pipeline's design is recorded: why the conflict test is written as
"no key", why the diff is taken against the base commit, why the give-up edge
is written three times. A generator that drops them moves the record out of
the file and into nothing.

So the protection against drift is not derivation but a test, and the test is
written to fail on exactly the thing that goes wrong: a change made to `dev`
and not to `dev-auto`.

## Alternatives

**Derive it with a longer regex.** Unreadable, and the failure mode is a
silently wrong graph rather than a failing test.

**Generate it from a shared object model, with the YAML as output.** The
comments go, and with them the reasoning. A separate comment store keyed by
node id is a worse version of the file.

**Review the two by eye when either changes.** That is what happened between
the hand-written copy and the shipped one, and it produced a merge-request
node that only one pipeline had.

**Leave the drift to be found by a run.** A wrong edge in an unattended
pipeline is found hours later by reading a failed run, which is the failure
mode this whole change exists to remove.

## How it works

`DEV_AUTO` is a template literal beside `DEV` and `DEV_QUICK`, registered in
`DEFAULT_WORKFLOWS` as `dev-auto`. The `clarify` node keeps its id — outputs
are keyed by node id, and the shipped planner reads its answers as
`clarify.answers` — and runs the `decide` agent instead of the `clarify` one.

The test in `tests/defaults.test.ts` asserts four things:

- the list of nodes `dev` has and `dev-auto` does not, by id: the person's
  three turns and the terminals that exist because a node can hold for them;
- the list `dev-auto` has and `dev` does not: `objection-needs-a-person` and
  `never-planned`;
- for every node both have, that the body is identical — type, agent, command,
  terminal status — with `clarify` the only exception, because the agent it
  runs is the difference;
- that the routing is identical too, except for six named nodes whose edges
  point at something this road does not have, and that more than ten nodes
  fall outside that exception, so the list of six cannot quietly grow to
  cover the whole graph.

A node added to `dev` fails the first list. A command changed in `dev` — the
merge-request node's host handling, say — fails the body comparison. An edge
retargeted in `dev` fails the routing comparison unless the node is one of the
six, and those six are named individually rather than skipped by a flag.

The record round is inside that net: `verdict` is one of the six, so its edges
are not compared, but `record-fix` and `record-wrong` are nodes both graphs
have, and their bodies are compared like any other.

## Consequences

A change to `dev`'s graph is now a change to three things' worth of
expectation — `dev`, its derivation into `dev-super`, and this test. That cost
is what is being bought, and it is paid at the moment the change is written
rather than in a run weeks later.

The exception list is the thing to watch. Six named nodes is a small enough
number to read; a seventh should have to be argued for, which is why they are
named one per line with the reason beside each.

## Touches

- `src/workflows/defaults.ts`
- `tests/defaults.test.ts`
- `docs/design/dev-workflow.md`
- `plugins/gate/reference/authoring.md`

## Supersedes

none. It completes [0025](0025-the-autonomous-road-answers-the-planners-questions-itself.md),
which decided what the road is without deciding how it stays in step.
`dev-super`'s derivation is unchanged and still right for what it does.
