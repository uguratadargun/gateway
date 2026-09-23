Status: done
Branch: fix/search-files-walk
Decisions: none — bug fixes inside the existing tool design
Design: docs/design/workspaces.md

# The gate executor's other tools, checked for the search_files fault

## Goal

After `search_files` was fixed
(`docs/specs/2026-09-23-search-files-reaches-the-whole-tree.md`), the question
was whether other agents have the same kind of fault: a tool limit that hides
part of the repository and says nothing, so the agent draws a conclusion from
what it was never shown.

## Which agents it can reach

Only agents with `executor: gate` use gate's own tools. The `claude-code`
executor hands the node to a headless Claude Code, which uses its own tools
(ripgrep, ranged reads). None of the planners, implementers, reviewers or
verifiers in `dev`, `dev-super` or `dev-quick` were affected. On the gate
executor are `recall`, `decide`, `plan-review`, `conflict-review`,
`acceptance` and `source-review`.

## What was found

- `list_files` walked depth first and stopped at 500 entries. Against
  ulak-desktop, a root listing at the default depth ended inside `tests/`: 110
  of 128 top-level entries were shown and `ts/`, the main source directory,
  was not. The output said it was truncated, but not that a whole top-level
  directory was missing. `recall`, `decide`, `plan-review`,
  `conflict-review` and `source-review` all list.
- `list_files` on a path that names a file answered `(empty)`.
- `run_command` kept the first 30 000 characters of output. A test runner or
  compiler prints its verdict last. No shipped gate-executor agent runs tests
  (`acceptance` runs `git rev-parse`), but a team's own gate-executor agent
  would lose the failures.
- `read_file` and the memory tools already say when they cut something.

## What was done

- `list_files` lists level by level, so every top-level entry comes before any
  deeper one. When it is cut, it says to what depth the listing is complete.
  On a file it refuses with "is a file; use read_file".
- `run_command` output over the cap is cut in the middle: a third from the
  start and the rest from the end, with the number of characters removed.

## What counted as done

- Three regression tests in `tests/tools.test.ts` failed against the old code
  and pass against the new.
- Against ulak-desktop at `f189b9254`, a root listing shows all 128 top-level
  entries, including `ts/`, and says it is complete to depth 1.
- `npm test`, `npm run typecheck` and `npm run docs:check` pass.
