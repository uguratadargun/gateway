Status: done
Branch: gate/init-reconciles-claude-md
Decisions: docs/decisions/0049-init-corrects-what-the-code-proves-wrong-in-claude-md.md
Design: docs/design/dev-workflow.md

# /gate:init corrects an existing CLAUDE.md

## What was asked

`/gate:init` should update a repository's existing `CLAUDE.md` so that it matches the code. Until now it only appended the record's table to the file.

## What was found

- On `ulak-desktop`, init left `CLAUDE.md` with these false lines:
  - a directory that does not exist (`ts/components/ppt/`);
  - files that were deleted (`CallManager.tsx`, `missions.ts`);
  - an old version;
  - a wrong "LiveKit is vendored" rule;
  - a wrong description of `ts/textsecure/Crypto.ts`.
- Init had found some of these, but wrote them as pitfalls in the design docs, which sessions read after `CLAUDE.md` or not at all.

## What was done

- **`plugins/gate/commands/init.md`:**
  - `CLAUDE.md` is the one existing file init edits: the record section plus the lines the code proves wrong. That covers a missing path, a figure against its owning file, and a false statement about the code.
  - Wording, order, language and unprovable lines stay as they are.
  - A rule the code merely breaks is kept.
  - The report lists each correction with its proof.
  - Design docs carry no pitfall about `CLAUDE.md`.
- **`plugins/gate/reference/docs.md`:** the `CLAUDE.md` section says the same.
- **Record:** decision 0049, `docs/design/dev-workflow.md`, and a changelog line.
- **Release:** version 0.48.0 in the three places, and the CLI rebuilt.

## What counted as done

- `npm run docs:check` clean.
- `npm run build:cli` accepts the three versions.
- Applied by hand to `ulak-desktop`'s `CLAUDE.md` under the same rules.
