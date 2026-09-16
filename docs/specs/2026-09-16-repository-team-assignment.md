Status: done
Branch: main
Decisions: —
Design: docs/design/repositories.md ("Whose it is"), docs/design/cross-team.md

# Whose repository it is, said on the page

## Goal

A repository's team decides whose `gate:ask` may read the code
(`src/orchestration/ask.ts` measures it against the asker's team tree), and the
column had existed since teams reached that table. Nothing in the dashboard set
it or showed it: every repository connected there belonged to nobody, and
nobody could see that it did. Setting it meant a `curl` against
`PATCH /api/repos/:id`.

Out of scope: the CLI, which still has no way to say it; per-team filtering of
the repository list, which is a different question from who may ask.

## Approach

The field goes where the repository is, on the Repos page, in both places a
repository is looked at: the connect form and the record afterwards. The team
select applies on change rather than behind a Save button — one value, no way
to half-type it — and a refused change puts the old owner back rather than
leaving an owner on screen the server does not hold.

Both API routes now refuse a `teamId` naming no team. That is the one way to
use this field and get a repository nobody can reach: owned in the record,
outside every asker's family, with nothing downstream saying why. Null keeps
meaning "nobody has said" and is still accepted.

No decision record: the access rule this serves is already recorded behaviour,
and nothing here reverses it.

## Assumptions

- Unowned stays readable by everyone on this gate. Narrowing every existing
  repository at once is the alternative, and it would hide the ones nobody
  meant to hide.
- A team deleted out from under a repository still names itself in the select,
  as `<id> (unknown team)`, rather than reading as unowned.

## Baseline

`npm test` — 708 passing, 1 skipped, green before and after. `npm run
typecheck` clean.

## Documentation

`docs/design/repositories.md` gains "Whose it is", a key file, and a pitfall.
`docs/design/cross-team.md` says where the family boundary is set. One
changelog line under Unreleased.

## What was built

1. `src/app/repos/page.tsx` — the team list, a select in the connect form, a
   select on each repository that PATCHes as it changes, and the refusal shown
   on the repository it was refused for.
2. `src/app/api/repos/route.ts`, `src/app/api/repos/[id]/route.ts` — a team id
   naming no team is a 400, on connect and on patch.
3. `tests/repo-team.test.ts` — assigning, handing back to nobody, and a refused
   owner leaving the stored one alone.

## Done when

- A repository can be given a team, and shown to have one, without leaving the
  dashboard.
- A team id that names no team never reaches the record.
- The suite and the typecheck are green.
