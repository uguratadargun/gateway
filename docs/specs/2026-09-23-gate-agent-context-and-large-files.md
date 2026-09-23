Status: done
Branch: fix/search-files-walk
Decisions: docs/decisions/0045-gate-agents-clear-old-tool-results.md
Design: docs/design/workspaces.md

# Gate agents stay small, and search reads large files

## Goal

After the tool fixes (`2026-09-23-search-files-reaches-the-whole-tree.md`,
`2026-09-23-gate-executor-tools-audit.md`), the remaining risks on gate's
own executor were fixed:

1. The loop never removed anything from the conversation. One `ask` answer
   re-read 8.4M cached tokens over 119 rounds, and a longer node would reach
   the model's context window.
2. `search_files` skipped every file over 200 KB, the same limit as
   `read_file`. In ulak-desktop that included `ts/sql/Server.ts`.

Also checked, with nothing to change: whether any gate-executor prompt names
a tool the agent does not have. None do. The four that mention
`AskUserQuestion` are `asks:` nodes, and they are told when they run
unattended.

## What was done

- Once a round's context reaches 100 000 tokens, the loop replaces every tool
  result older than the last five rounds with a note naming the call. This
  happens in one batch, and each result is cleared only once. The step keeps
  the full results (decision 0045).
- `search_files` reads files up to 5 MB, skips binary files, and names any
  file it did not read.

## Not changed, and why

- Model routing is the gate's `routing.json`, not code. The slow `ask` runs
  came from its `sonnet` tier pointing at `glm-5.3-flash`, and the tier now
  points at `claude-sonnet-5`.
- Search is still JavaScript over files rather than ripgrep. It searches
  ulak-desktop's 2 737 files in under a second, and a tree past 20 000 files
  says it stopped.

## What counted as done

- A test drives the loop with a fake model that reports a large context from
  its eighth call. The three oldest results become notes that name
  `read_file big.txt`, and the last five stay whole. A cleared result is not
  rewritten, and the step keeps every full result. A second test shows that
  a small conversation is never touched.
- A test finds a match on line 30 001 of a 300 KB file, and does not report
  a binary file that happens to contain the same bytes.
- `npm test`, `npm run typecheck` and `npm run docs:check` pass.
