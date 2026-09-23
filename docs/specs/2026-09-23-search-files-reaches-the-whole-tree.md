Status: done
Branch: fix/search-files-walk
Decisions: none — a bug fix inside the existing tool design
Design: docs/design/workspaces.md

# search_files reaches the whole tree

## Goal

On the live gate, `gate ask` runs about ulak-desktop took five to twelve
minutes, while the same question asked in a local Claude Code session in the
repository was answered in under a minute. Part of the gap was the model: the
`sonnet` tier was routed to `glm-5.3-flash`, and every round took 6–18 seconds
for a few dozen tokens. Once the tier was routed to `claude-sonnet-5`, rounds
took 2–3 seconds, but the reviewer still went round in circles. It searched
`ts/textsecure/MessageReceiver.ts` for `.`, `import` and `class
MessageReceiver` and got `(no matches)` every time.

The cause was `search_files`, which read files through the same walk as
`list_files`. That walk:

- stopped at 500 entries in alphabetical order. ulak-desktop has 2 737 files,
  so a search from the root ended at `images/icons/v2/…` and never reached
  `ts/` or `js/`, and a search under `ts/` ended at `ts/quill/…` and never
  reached `ts/textsecure/`;
- called `readdirSync` on a path that names a file, failed, and searched
  nothing.

Neither limit said anything. The answer was `(no matches)`, which a reviewer
reports as the feature not being in the commit.

## What was done

- A path that names a file searches that file.
- A search walks its own generator with no listing cap. It stops at 100
  matches, or after 20 000 files as a bound on a very large tree.
- Every limit that hid something is written under the matches: the match cap,
  the file cap, and the files over 200 000 bytes that were not read (up to ten
  named, then a count).
- A path that does not exist is an error instead of `(no matches)`.

## What counted as done

- Three regression tests in `tests/tools.test.ts` failed against the old code
  and pass against the new: a file path is searched; a file past 600 earlier
  entries is found; the match cap and a too-large file are reported. The
  existing symlink test still gets a bare `(no matches)`.
- Against the ulak-desktop checkout at `f189b9254`, a root search for
  `handleSyncMessage` finds `ts/textsecure/MessageReceiver.ts:3236` in 0.7 s,
  and `import` scoped to `ts/textsecure/MessageReceiver.ts` finds its imports.
- `npm test`, `npm run typecheck` and `npm run docs:check` pass.
