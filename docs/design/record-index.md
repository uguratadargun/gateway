# Record index

## Summary

Every repository connected to the gate keeps its own record: how each feature works, why it was built that way, what each piece of work set out to do. The record index reads that record from each repository's base branch, so any team in the tree can find it, whether or not the team that wrote it ever ran gate. The same read answers three questions about the work gate has recorded:

- Did it land?
- Did its record move?
- Does the code it describes still exist?

It also gives the history of any part of a repository, commit by commit, with the reasoning each commit points to.

## How it works

### What is read

For each connected repository with a checkout on the server, the index resolves the base branch: the repository's base ref, or else the branch the remote's HEAD names. It fetches that branch into a ref of its own, `refs/gate/record/base`, so a concurrent `ask` fetch cannot move what it reads. Then it lists the record at that commit:

- `docs/design/<feature>.md`: a **design doc**. Its file name is the feature's id.
- `docs/decisions/NNNN-<slug>.md`: a **decision record**, with its number, Status and Date.
- `docs/specs/YYYY-MM-DD-<topic>.md`: a **spec**.
- `docs/ARCHITECTURE.md`: the **map**.

Nothing else under `docs/` is a record. Each document is kept as one row: kind, slug, number, title, status, date, a summary (a design doc's Summary section, a decision's Decision section), the whole text, git's blob hash, and the commit it was read at. A full-text row is kept beside it. A document whose blob hash has not changed is not read again. A document gone from the branch is deleted, with its full-text row, its vector and its interfaces.

Reading is code: the documents have a form that `scripts/check-docs.mjs` holds (0021), so nothing here asks a model anything. Every row is derived, and dropping them all and reading again loses nothing.

### A design doc is its feature

A design doc's file name is its feature's id in the tree's catalogue: `offline-sync.md` in android's repository and `offline-sync.md` in desktop's are the same feature. A design doc whose feature the catalogue lacks opens it, owned by the root of the repository's team tree, with the doc's title as its name and the Summary's first sentence as its line. A feature the catalogue already has keeps its name and aliases. A feature's detail carries every repository's design doc for it, and a feature counts as built by every team that has a page on it or a design doc for it. A run that wrote exactly one design doc is filed under that doc's feature by the recorder, whatever the model called the work.

### Interfaces

A design doc may have an `## Interfaces` section, with one line per thing the feature offers other repositories or uses from them:

```markdown
## Interfaces
- provides: `POST /v1/sync` — the batch endpoint every client pushes to
- consumes: sync.accepted event — clears the local queue
```

Each line is kept as a row: role, name, note, and the doc it came from. A search whose words name an interface returns every repository on either side of it, with the design doc where each says how it integrates. This answers "if the server changes this, who has to follow, and how did each of them integrate it".

### What the read settles about recorded decisions

After the documents, the index reconciles the decisions recorded from runs in the same repository:

- **Work that landed.** A decision that was not refused, not retracted, and is `pr-open`, `completed`, `unshipped` or `abandoned` becomes `merged` when one of these holds:
  - its run's head commit, or the commit its run published, is in the base branch's history, and differs from the run's base commit (a run that changed nothing has its base as its head);
  - the decision record the run wrote is on the base branch, which catches a squash merge.

  What the run reported when it ended does not matter: a failed run merged by hand is `merged`.
- **Records that moved.** A decision touch under `docs/decisions/` that is not on the base branch follows the record's slug to its path there, when exactly one record has that slug. The decision's touch, its JSON and its full-text row all move, so a path search for the record's real name finds it.
- **Records superseded on the branch.** A decision record whose Status says `superseded` closes the decisions written from it (`valid_to`).
- **Code that is gone.** A decision whose work landed (`merged`, `shipped`, `deployed`) has its file touches checked against the branch's tree. A directory counts as present when any file is under it. The decision keeps the commit it was checked at and how many of its files were missing. One whose every file is gone is shown as describing code that no longer exists.

### History

`gate memory history --path <prefix> [--since 30d]`, the `memory_history` tool, and `GET /api/v1/memory/history` read `git log` in the server's checkout at the commit the index last read, on the asked paths. The result is every commit, a person's as well as a run's, newest first. Each commit carries the paths its body's `Documents:` line names and the gate run it came from: a run whose head or published commit it is, or the `gate/run-<id>` its message names. Nothing is copied: git keeps the history, and the index only says which commit it is true of. The asker's family is the boundary, as for every read.

### When it reads

- On a timer. `memory.indexEveryMinutes` (Settings → Memory, 15 by default, 0 to leave it to the button) is checked once a minute, and a pass reads every repository once the oldest read is older than that.
- On request. **Read repositories** on `/memory` (`POST /api/memory/index`) reads them all now and reports what changed.

One pass runs at a time per process. After a pass, anything without a vector gets one when an embedding provider is configured. The Memory page lists each repository's ref, commit, document count, when it was read, and the error when a read failed. A failed fetch still reads the commit fetched last time.

### Merges without gate

With `memory.recordMerges` on, the same pass turns each first-parent commit that reached the base branch since the last pass into a finished run of `gate:merge` for the recorder. Gate's own work is skipped. See [memory](memory.md).

## Key files

- `src/memory/record-index.ts` — reading a document, indexing a repository, reconciling decisions, searching documents and interfaces, path history, the status the Memory page shows
- `src/memory/merges.ts` — merges made without gate, kept as runs of `gate:merge`
- `src/memory/hybrid.ts` — documents searched by words and vectors, and their vectors made
- `src/memory/store.ts` — the writes the index makes to decisions: `markMerged`, `renameTouch`, `closeByRecord`, `recordTouchCheck`
- `src/lib/db.ts` — `record_repos`, `record_docs`, `record_interfaces`, `record_docs_fts`
- `src/instrumentation-node.ts` — the timer
- `src/app/api/memory/index/route.ts` — status and read-now for the dashboard; `src/app/api/v1/memory/history/route.ts` — history for a client
- `src/app/memory/page.tsx` — the repositories read, documents and interfaces in a search, design docs on a feature

## Pitfalls

- A repository needs a checkout on the server to be read. A team whose repository is only on laptops is invisible to the index until the repository is connected on the Repos page.
- The index reads the base branch only. An open branch's documents are not in it. That is what the in-flight list and `ask` at a published branch are for.
- The squash-merge rule trusts a decision record's slug: a different record with the same slug on the base branch would promote a decision that never landed.
- A repository with no team is readable by every team on the gate, the same rule `ask` keeps. Give it a team on the Repos page to scope it.
- The fetch is `git fetch` against the repository's publication remote, or `origin`. A checkout whose credentials have lapsed keeps answering from the last commit it fetched, and says so on the Memory page.
- Interfaces are matched by name as written. `POST /v1/sync` and `/v1/sync POST` are two interfaces, so write the name the same way on both sides.

## Decisions

- [0038 — The repositories' record is read by code, and the base branch settles what landed](../decisions/0038-the-repositories-record-is-read-by-code.md)
- [0041 — Merges made without gate are recorded only when the gate is set to](../decisions/0041-merges-made-without-gate-are-recorded-when-asked.md)
- [0021 — The record's form is checked by code, its truth by a reviewer](../decisions/0021-the-records-form-is-checked-by-code.md)
- [0005 — The repository keeps its own record, and the pipeline writes it with the code](../decisions/0005-docs-as-code-in-every-repository.md)
