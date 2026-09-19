# 0021. The record's form is checked by code, its truth by a reviewer

Status: accepted
Date: 2026-09-19
Run: manual

## Context

0005 made the repository's markdown the source of its record and gate's
memory the index. It gave every kind of statement a place and a form, and it
gave the pipeline the job of keeping them: the planner names the documents,
the implementer writes them, the reviewer and verifier hold the change
against them, and one command node, `record`, checks that a spec exists. All
of that except the last is a model reading the tree. Three days in, the tree
had two records numbered 0018 — written by two runs on the same day, each
taking what was the next free number when it planned, each reviewed and
found fine, because a reviewer reads the record it is shown and not the
directory beside it. Nothing said so until a person listed the directory.

The mistake was cheap, but it is the kind that compounds: every pointer to
"0018" now names two files, memory's `--path docs/decisions/0018` search
returns both, and the next record has to know which number is really free.
The same shape of mistake was waiting elsewhere — a design doc linking a
record that was renamed, a spec whose `Decisions:` line says `—` where the
form says `none`, a section left empty — and each one is a fact about the
files, not a judgement about their content.

## Decision

A script checks the form of the record — the shapes and the pointers the
convention fixes — and runs inside `npm test`, so a record in the wrong shape
fails the suite the verifier runs. It reads and never writes. Whether a
record is true stays a reviewer's judgement.

## Rationale

A model reviewer sees the record it was handed and sometimes the directory;
a script sees the whole tree every time, for nothing. Splitting the work by
what each is good at — form to code, truth to judgement — is the same split
0001 makes for routing and 0005 makes for the spec check, applied to the
rest of the form. Putting the check in the test suite rather than a separate
step means it costs no new node and no new habit: the verifier already runs
the suite, and `npm run docs:check` is there for a hand. Reporting every
problem rather than the first is what makes the output a to-do list rather
than a loop.

## Alternatives

Rely on the reviewer, with a sharper prompt that says to list the directory.
Rejected: it had the chance and missed it, and every prompt line spent on
counting files is a line not spent on whether the record is true.

Extend the shipped `record` command node to check the form in every
repository. Not now: the shipped node runs on the developer's machine with
nothing but `sh` and `git`, and a checker there has to travel in the plugin
CLI, which is a version bump and a contract with every team's repository.
The convention allows a project to say its layout differs; a form check
shipped to all of them would have to allow the same. This record leaves that
door open and takes the one that is this repository's alone.

Let the check renumber or fix what it finds. Rejected: which of two records
keeps a number is a question of which came first, and a script rewriting a
decision record contradicts the rule that a record is never edited. The check
names the problem; a person fixes it.

Check that every decision is linked from some design doc, and that the
`Decisions` list is newest first. Left out: several accepted records stand
on their own by design, and the order of a list is a nicety the reader
forgives. A check that fails on the acceptable is turned off, not read.

## How it works

`scripts/check-docs.mjs` exports `checkRecord(root)`, which walks
`docs/decisions/`, `docs/design/`, `docs/specs/`, `docs/ARCHITECTURE.md`,
`CHANGELOG.md` and `docs/plans/.gitignore` and returns one line per problem,
each starting with the file's path. The checks are the forms in
`plugins/gate/reference/docs.md`, read literally: names, first lines, the
`Status:`/`Date:` lines, the fixed sections in their order with nothing
empty, unique and gapless decision numbers, supersession said on both
records, every link and `decisions/NNNN-` pointer landing on a file, spec
headers with the four keys in order and their paths present. Where the
convention leaves room — a reason after `none`, a spec header wrapping onto
more lines, extra keys after the four, extra sections in a design doc — the
check leaves the same room. `tests/docs-record.test.ts` asserts the
repository's own record returns no problems, and holds the checker to a
fixture tree with each mistake planted. Run directly, the script prints the
problems and exits 1.

The two 0018s were resolved by hand in the same change: the record written
second, on provider models in the picker, became 0020 — the number that was
free — and every pointer to it moved with it. The record's body is unchanged.

## Consequences

`npm test` now fails on a malformed record, so a run of the `dev` pipeline
on this repository is sent back by its verifier when a documentation task
left the form wrong, before the reviewer reads it. A hand edit to `docs/` is
held to the same check the next time anyone runs the suite.

Renumbering 0018 to 0020 left gate's memory holding the old path among that
decision's touches; a path search finds it under the old name until the run
is recorded again. Memory's own record of the decision is intact.

The check is stricter than the existing record in one place it did not have
to give in: a spec's `Decisions:` line is `none`, not `—`; two specs were
changed to say so. It is looser than the letter of the convention in the
places the record already was — a `Run:` line is not required, and a
`History:` key after the four is allowed.

Any repository that wants this on its own runs has to carry a checker of its
own or wait for the shipped `record` node to grow one; this change gives it
to gate's repository only.

## Touches

- `scripts/check-docs.mjs`
- `tests/docs-record.test.ts`
- `package.json`
- `docs/decisions/0020-a-provider-model-reaches-the-picker-under-its-own-name.md`
- `docs/design/the-record.md`
- `docs/design/providers.md`
- `docs/design/routing.md`
- `docs/specs/2026-09-17-provider-models-in-the-model-picker.md`
- `docs/specs/2026-09-16-repository-team-assignment.md`
- `docs/specs/2026-09-17-filing-work-under-a-task.md`
- `docs/ARCHITECTURE.md`
- `CLAUDE.md`
- the-record

## Supersedes

none — 0005 stands; this record adds a check to the form 0005 fixed and
changes nothing about what the record is or who writes it.
