Status: done
Branch: main
Decisions: docs/decisions/0021-the-records-form-is-checked-by-code.md
Design: docs/design/the-record.md (new), docs/design/providers.md, docs/design/routing.md (pointers to the renumbered record)

# The record's form is checked by code

## Task

Asked, in review of how the repository's record and gate's memory relate:
is keeping both best practice, and is it done as well as it can be? The
answer was that the split — markdown as source, memory as index — is right,
and that the weak point is the form being guarded by a reviewer alone; the
tree already had two records numbered 0018. Then: improve whatever can be
improved in the repository's record.

## Done

- `docs/decisions/0018-a-provider-model-reaches-the-picker-under-its-own-name.md`
  became `0020-…`, the number that was free; its heading follows, its body is
  untouched. The pointers in `docs/design/providers.md`, `docs/design/routing.md`
  and `docs/specs/2026-09-17-provider-models-in-the-model-picker.md` moved
  with it. The record written first that day, on unfinished work taught as
  in-progress, keeps 0018.
- `scripts/check-docs.mjs` checks the form of the whole record — decision
  numbers unique and gapless, headings, `Status:`/`Date:` lines, the eight
  and the five sections present, in order and non-empty, supersession said on
  both records, every design-doc link and `decisions/NNNN-` pointer landing
  on a file, spec names and headers with the four keys and their paths
  present, the map, `## Unreleased`, the ignored plans directory. It reports
  every problem, reads and never writes. `npm run docs:check` runs it.
- `tests/docs-record.test.ts` runs the same check over this repository
  inside `npm test`, and holds the checker to fixtures of each mistake.
- Two specs said `Decisions: —`; they say `none` now, as the form does.
- `docs/design/the-record.md` describes the record as this repository keeps
  it and what the check holds it to; `docs/ARCHITECTURE.md` points at it,
  and `CLAUDE.md` lists the command.
- Not done, and recorded as the alternative left open in 0021: teaching the
  shipped `record` command node to check the form in every repository, which
  is a plugin change with a version bump.

Run: `npm run docs:check` (clean), `npx vitest run tests/docs-record.test.ts`
(8 passed), `npm run typecheck`, `npm test` (whole suite, passed).
