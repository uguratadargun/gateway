# The record

## Summary

The repository keeps what is true about itself in files a person can read
without gate: how each feature works, why it is that way, what each piece of
work set out to do, and what shipped when. gate's memory indexes those files;
it never replaces them. Whether a record is *true* is a judgement, and the
pipeline's reviewer makes it. Whether a record has its *form* — one number per
decision, every section present, every pointer landing on a file that exists —
is a fact about the tree, and a script checks it on every test run, so a
malformed record fails the suite instead of waiting for a reader to notice.

## How it works

The four kinds of document, their places and their forms are the convention
in `plugins/gate/reference/docs.md`, which ships with the plugin and holds for
every repository gate works in. This repository follows it like any other:
`docs/design/<feature>.md` for the present tense, `docs/decisions/NNNN-<slug>.md`
for a choice made once and never edited, `docs/specs/YYYY-MM-DD-<topic>.md`
for what a task asked and what counted as done, `CHANGELOG.md` for releases,
`docs/ARCHITECTURE.md` as the map. `docs/plans/` is gitignored scratch.

The check reads the whole record and reports every problem it finds, each
line naming the file:

- **Decisions.** The file is `NNNN-<slug>.md` and its first line `# NNNN.
  <Title>` with the same number. Numbers are unique and run without a gap
  from 0001, because each record takes the next free number. `Status:` is
  `accepted` or `superseded by NNNN`; `Date:` is a real `YYYY-MM-DD`. The
  eight sections — Context, Decision, Rationale, Alternatives, How it works,
  Consequences, Touches, Supersedes — are all present, in that order, none
  empty, and no other `##` section is there. `Supersedes` is `none`
  (optionally followed by why nothing covered this) or names earlier records
  by number. Supersession is said on both sides: a record whose Status says
  `superseded by 0009` is named in 0009's `Supersedes`, and the number named
  exists and is later.
- **Design docs.** `<feature>.md` in lower-case words, a `# <Feature>` first
  line, the five sections — Summary, How it works, Key files, Pitfalls,
  Decisions — present, in order, none empty; other `##` sections are allowed.
  Every markdown link into `../decisions/` lands on a file, a link whose text says
  `0012` points at `0012-…`, and every `decisions/NNNN-` pointer in the prose
  names a record that exists.
- **Specs.** `YYYY-MM-DD-<topic>.md` with a real date. The header is the
  block above the first blank line: `Key: value` lines, a long value wrapping
  onto the lines below, the first four keys `Status`, `Branch`, `Decisions`,
  `Design` in that order, more keys after them allowed. `Decisions:` and
  `Design:` are `none` (optionally with a reason) or name paths under `docs/`
  that exist.
- **The fixed files.** `docs/ARCHITECTURE.md` exists, `CHANGELOG.md` has a
  `## Unreleased` section, `docs/plans/.gitignore` ignores `*`.

`npm run docs:check` runs it and exits non-zero with the list;
`tests/docs-record.test.ts` runs the same function over this repository
inside `npm test`, which is the suite the pipeline's verifier runs, and holds
the checker itself to fixtures of each mistake. The check reads and never
writes: a wrong number is renumbered by hand, with every pointer to it,
because which of two records keeps the number is a judgement about which
came first.

The check is this repository's, not the shipped pipeline's. The `record`
command node in the shipped workflows checks one fact about any repository's
record — that a spec was written — and the reviewer judges the rest; a
project that wants its record's form checked on every run adds a command
node for it, as it would for `npm test`.

## Key files

- `scripts/check-docs.mjs` — the checker: `checkRecord(root)` returns the problems; run directly, it prints them and exits 1
- `tests/docs-record.test.ts` — the repository's own record has its form; the checker catches each mistake on a fixture tree
- `plugins/gate/reference/docs.md` — the convention the check enforces the form of
- `CLAUDE.md` — the table that tells a session what the record requires of a change

## Pitfalls

- Renumbering a decision record does not reach gate's memory: the recorder
  stored the old path among the decision's touches, so `gate memory search
  --path docs/decisions/<old>` still finds it and the new path finds nothing
  until the run is recorded again.
- A decision superseded in part still gets `Status: superseded by NNNN`; the
  new record's `Supersedes` says what still holds. The check wants the two
  lines to agree and does not read the nuance.
- The gap check reads all of `docs/decisions/`: two branches each taking the
  next free number merge into a duplicate, which the check reports on the
  branch that merged second, not on either alone.

## Decisions

- [0021 — The record's form is checked by code, its truth by a reviewer](../decisions/0021-the-records-form-is-checked-by-code.md)
- [0005 — The repository keeps its own record, and the pipeline writes it with the code](../decisions/0005-docs-as-code-in-every-repository.md)
