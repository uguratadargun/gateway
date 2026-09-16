# What a repository keeps written down, and where

A run changes code, and it changes what is true about the system. The code is
in the diff; what is true has to be written somewhere a person can read it
six months later, when the person who made the change is not in the room.
Four questions come up, and each has one place:

| Question | Where | Lifetime |
| --- | --- | --- |
| How does this work today? | `docs/design/<feature>.md` | rewritten in place; no history |
| Why was it decided this way? | `docs/decisions/NNNN-<slug>.md` | written once, never edited; a change is a new record that supersedes |
| What was asked, and what counted as done? | `docs/specs/YYYY-MM-DD-<topic>.md` | the final plan of a run, copied when the run's last task is committed |
| What shipped when? | `CHANGELOG.md` | one entry per release |

And a map: `docs/ARCHITECTURE.md` — the modules, their boundaries, and the
invariants that hold everywhere. One or two pages, rewritten in place.

`docs/plans/` is the pipeline's working directory. The planner writes there,
the implementer, verifier and reviewer read there, and the pipeline keeps it
out of the commit with a `.gitignore` of `*`. Nothing under it is ever the
record.

```
docs/
  ARCHITECTURE.md
  design/<feature>.md
  decisions/NNNN-<slug>.md
  specs/YYYY-MM-DD-<topic>.md
  plans/                   # gitignored by the pipeline
CHANGELOG.md
```

The same shape holds in gate's memory: a decision record is one row in the
team's memory, with the same fields, and a design doc is the team's
implementation summary of a feature. When a run writes one of these files, the
recorder reads it from the run's diff and records it as the run's decision,
with the file's own path among the places it touches — so
`gate memory search --path docs/decisions/0007` finds the record the file
made, and a recall before the next run cites the file for the planner to
read. The file in the repository is the source; memory is the index.

## `docs/design/<feature>.md` — how it works today

One file per feature, named for the feature the product has (`memory.md`,
`account-pool.md`), not for the task that built it. It describes the feature
as it stands: rewrite the sentence that is no longer true, do not add a
paragraph that says what changed. History is what `git log` on the file is
for, and what the decisions are for.

```markdown
# <Feature>

## Summary
One paragraph. What the feature does for the person using the product, in
product terms, without naming a platform or a file.

## How it works
The flow, the states, the invariants. Logic, not code: what happens in what
order, what is true before and after, what can never happen. A path is a
pointer; a function body is not.

## Key files
- `path/to/file.ts` — what it owns

## Pitfalls
- Traps that are still true today, one per line. What looks like it would
  work and does not, and why.

## Decisions
- [0012 — Title](../decisions/0012-slug.md)
- newest first
```

## `docs/decisions/NNNN-<slug>.md` — why

One file per real choice: a point where something else could have been done
and was not. A bug fix that follows the existing design is not a decision. A
task that reverses an earlier decision is one, and the earlier record gets a
`Status: superseded by NNNN` line — its body is never edited, because what
was true when it was written is the point of keeping it.

`NNNN` is the next free number under `docs/decisions/`, zero-padded to four.
The sections are the fields of a decision in gate's memory, in the same
order, so a record can travel between the two without translation.

```markdown
# NNNN. <Title>

Status: accepted
Date: YYYY-MM-DD
Run: <branch, execution id, or "manual">

## Context
What was true before, and what the change was for.

## Decision
What was decided, in one or two sentences.

## Rationale
Why this, over the alternatives below.

## Alternatives
Options considered and not taken, and why not. One per paragraph.

## How it works
The flow, the states, the invariants the decision introduces. Not code.

## Consequences
Risks, trade-offs, and what the next change here needs to know.

## Touches
- `src/path/to/file.ts`
- area-name

## Supersedes
none
```

`Status` is `accepted`, or `superseded by NNNN`. `Touches` lists paths
relative to the repository root and short area names (`sync`, `auth`), one
per line — the same paths the run changed, where the decision lives in them.

## `docs/specs/YYYY-MM-DD-<topic>.md` — what was asked

The plan the run was built from, as it was when the last task was committed.
The implementer copies the plan file's final revision there and puts a block
above it:

```markdown
Status: done
Branch: <the run's branch>
Decisions: docs/decisions/0012-slug.md
Design: docs/design/feature.md
```

`Decisions` and `Design` name the files this run wrote or changed, or `none`.
The date and topic come from the plan file's name; a `-rev2` suffix is
dropped, because the spec is the plan as finished, not each pass of it. The
directory is the list of everything that was built, in the order it was
built, each with what "done" meant at the time.

A quick change (`dev-quick`) has no plan to copy, so its spec is short: the
same four lines, `Decisions: none`, then a `## Task` section with the task
as it was given and a `## Done` section saying what changed and what was
run. Half a page at most; it is the entry in the list, not a plan.

Whether the spec is there is the one thing about the record the pipeline
checks without a model: a `record` command node after the verifier looks
for a new file under `docs/specs/` and, when there is none, sends the
implementer back with what to write, three times, before the run ends on
`no-spec`. Whether the design doc and the decision record are *true* is a
judgement, and the reviewer's.

## `CHANGELOG.md` — what shipped when

[Keep a Changelog](https://keepachangelog.com) form: a `## Unreleased`
section at the top, then one `## <version> — <date>` per release, each with
the changes under it as one line each. A release commit moves `Unreleased`
under the new version; in gate's own repository `npm run changelog:release`
does that from `GATE_VERSION`, and the CLI build warns when the version
being built has no entry. The line says what changed for the person using
the product, not which file moved.

## What the pipeline does with these

- The **planner** reads `docs/ARCHITECTURE.md` and `docs/design/` before it
  plans, and writes a `## Documentation` section into every plan: which
  design doc the change touches, whether it is a decision, or `none` with the
  reason. A plan that is not `none` ends with a `Task N: Documentation` whose
  **Files** are the design doc and the decision record.
- The **implementer** does that task like any other, commits it under its own
  name with the record's path in the body, and, when the last task is
  committed, copies the plan to `docs/specs/` as one more commit. Its summary
  names the documents it wrote, and that line becomes part of the commit body.
- The **record** node, a command after the verifier, checks that the spec
  is there and sends the implementer back with what to write when it is not.
- The **reviewer** holds the change against the documents: behaviour that
  changed while the design doc describing it did not is a finding, and so is
  a decision record with an empty section or code pasted into it.
- The **recorder** reads the decision records and design docs from the run's
  diff and records them as the run's decisions and the feature's summary, with
  the files' paths among the touches.
- **Recall**, before the next run, cites the file when a decision touches one,
  so the planner reads the record rather than a summary of it.
- The **investigator**, when something broke, follows `git blame` to the
  commit, the commit body to the record, and the record to the decision that
  made it so.

## The repository's `CLAUDE.md`

The pipeline's agents carry the convention in their prompts. A person using
Claude Code in the repository without the pipeline does not, unless the
repository says it: put this table in the repository's `CLAUDE.md`, where
every Claude Code session reads it, and `/gate:design` proposes it for a
repository that has none.

```markdown
## The record — what goes where, and when it is required

Read `docs/ARCHITECTURE.md` first, then the design doc of the feature you
are changing under `docs/design/`. Forms: <link to this reference>.

| You did | You must |
| --- | --- |
| Changed behaviour a design doc describes | Rewrite the sentence in `docs/design/<feature>.md` so it is true now. Never add "what changed". |
| Built something no design doc covers | Create `docs/design/<feature>.md`: Summary, How it works, Key files, Pitfalls, Decisions. |
| Made a real choice, or reversed an earlier one | Write `docs/decisions/NNNN-<slug>.md`, next free number, all eight sections. Logic, not code. |
| Reversed a recorded decision | Add `Status: superseded by NNNN` to the old record. Change nothing else in it. |
| Finished a task | Write `docs/specs/YYYY-MM-DD-<topic>.md`: Status, Branch, Decisions, Design, then what was asked and what counted as done. |
| Changed what the product does | One line under `## Unreleased` in `CHANGELOG.md`. |

Not required: a decision record for a bug fix that follows the existing
design, a design doc for a refactor that changed no behaviour. `docs/plans/`
is gitignored scratch space. A commit that touched the record names the
files in its body: `Documents: docs/decisions/0007-x.md, docs/design/sync.md`.
```

## What not to do

- Do not write into a design doc what used to be true. That is a decision
  record's job, or `git log`'s.
- Do not edit a decision record. Supersede it.
- Do not write by hand what the code can generate: an API schema, a workflow
  graph, a list of routes. Generate it, or point at where it is generated.
- Do not turn `docs/specs/` into a changelog. A spec is what one run set out
  to do; the changelog is what a release shipped.
- Do not add a documentation agent to a pipeline. The shipped planner,
  implementer and reviewer already carry this; a project with its own layout
  says so in the task or in a command node, not in a second planner.
