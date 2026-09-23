Status: done
Branch: gate/memory-best-practices
Decisions: docs/decisions/0042-init-names-features-after-the-tree-and-leaves-reading-to-the-index.md,
docs/decisions/0043-writing-outside-the-convention-is-read-as-notes.md
Design: docs/design/record-index.md, docs/design/dev-workflow.md,
docs/design/memory.md

# /gate:init, brought in line with the record index

## What was asked

Check whether `/gate:init` is best practice and fits the cross-team memory work of 0.45.0, and update it where it does not.

## What was found

- **The command named design docs without looking at the tree.** Since 0.45.0 a design doc's file name is its feature's id across the tree, so two teams naming the same feature differently get two features that never meet.
- **It taught every feature through a model.** The record index already reads the same documents for nothing once they are merged on a connected repository. The teaching was a paid second copy that put every decision in recall twice.
- **It ignored writing already under `docs/` outside the convention.** The index ignored it too. On the live gate, the only connected repository (`ulak-desktop`) read 0 documents, although it has current write-ups such as `docs/mention-system.md` and `docs/superpowers/specs/…`.
- **It never checked whether the repository was connected at all.**

## What was done

- **`/gate:init`:**
  - It prints `gate memory repo` and `gate memory features` before it starts.
  - It reads existing notes first.
  - It searches the tree for every part it finds.
  - It shows each part's file name and whether that name is a sibling's before writing.
  - It names interfaces as a sibling already lists them.
  - It commits on `gate-init` with one commit per feature and teaches nothing. Teaching is kept only for a repository that cannot be connected.
- **The record index** reads other Markdown under `docs/` as notes (0043) and keeps a design doc's Pitfalls apart, shown on the feature's page.
- **New commands and routes:** `gate memory features` and `gate memory repo`, backed by `GET /api/v1/memory/features` and `GET /api/v1/memory/repo`.

## What counted as done

- `npm run typecheck` clean.
- `npm test` green: 839 tests. `tests/record-index.test.ts` covers notes, pitfalls and the repository status.
- `npm run docs:check` clean. 0006 is superseded in part by 0042.
- Version 0.46.0, changelog released, CLI rebuilt.
