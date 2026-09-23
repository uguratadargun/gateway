---
description: Set this repository up for gate — read it, write its architecture, design docs and decisions, and teach them to your team's memory
argument-hint: [what this repository is, if the code does not say]
---

<!-- No allowed-tools on purpose: reading a whole repository, writing its
     documents and, with the user's word, committing and teaching them, needs
     the ordinary set. -->

Who this machine is connected as, and to which team:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" whoami`

What a repository keeps written down, and where — the forms below are this
file's, and yours to follow exactly:

@${CLAUDE_PLUGIN_ROOT}/reference/docs.md

The user said this repository is: $ARGUMENTS

## What this is

A repository that has just met gate has no record: the pipeline expects
`docs/design/` to say how each feature works, `docs/decisions/` to say why,
`docs/specs/` to hold what each run set out to do, and `CLAUDE.md` to say
that all of this is required. Nothing before gate is in the team's memory
either, so the first planner starts blind on work that has been going on for
years.

This command writes that record once, from the code as it stands: the map,
a design doc per key part, the decisions the code and the history actually
show, and the skeleton the pipeline expects. Then, if the user says so, it
teaches those documents to the team's memory, so recall answers from the
first run — including about everything built before gate.

It writes files. **It does not commit anything on its own**, and it never
overwrites a document that is already there.

## 1. See what is already there

Look for `docs/ARCHITECTURE.md`, `docs/design/`, `docs/decisions/`,
`docs/specs/`, `docs/plans/.gitignore`, `CLAUDE.md`, `CHANGELOG.md`.

- Anything that exists is **left exactly as it is**. You add what is missing;
  you do not rewrite, reformat or "improve" a file the repository already
  has. The one exception is `CLAUDE.md`, and only by appending one section —
  see step 4.
- Running this command twice is safe, and that is the reason.
- Run `git status --porcelain`. If the checkout is dirty, say so and carry
  on: nothing here is committed without being asked, but the user should
  know which of the changes are theirs.
- If `whoami` above printed an error, say which: `not connected` means
  `/gate:login <token>` with a token from the dashboard. Write the documents
  anyway — they are worth having — and skip step 6, saying so at the end.

## 2. Read the repository

Do not design against assumptions. Establish, from the files:

- what it is and what it is for — the entry points, the product's own words
  in a README or a package description, and the user's arguments above;
- how it is laid out: where source, tests and configuration live, whether it
  is a monorepo, what the top-level directories own;
- the **exact commands** it is built, tested, linted and typechecked with,
  from `package.json`, a `Makefile`, `pyproject.toml`, CI workflow files —
  whatever is really there;
- how changes reach it: the remote, the default branch, whether merge
  requests are used, and the shape of its commit subjects
  (`git log --format=%s -50`);
- where reasoning is already written down: a README section, design notes,
  an `ADR`-like directory under another name, long comments that explain a
  choice, commit messages that argue for one.

Where the repository is large, send subagents: one area each, all at once,
each reporting what it found rather than pasting files back. Read the rest
yourself while they work.

## 3. Show what you would write, and let them choose

List the key parts you found — one line each, named as the product names
them (`offline sync`, `account pool`), not as a task (`refactor of sync`).
A part is worth a design doc when someone maintaining this repository would
ask "how does this work"; a utility file is not.

Then ask with AskUserQuestion: write all of them, or a subset. Say plainly
what each line costs — one `docs/design/<feature>.md`, and, if they choose
to teach in step 6, one teach run apiece — so the size of the job is theirs
to decide. Do not start writing before they answer.

## 4. Write the documents

The forms are in the reference above. Follow them section for section.

- **`docs/ARCHITECTURE.md`** — the map: the parts, the boundaries between
  them, the invariants that hold everywhere, a pointer to each design doc,
  and a short file map at the end. One or two pages, not a summary of every
  file.
- **`docs/design/<feature>.md`**, one per part the user chose — Summary, How
  it works, Key files, Pitfalls, Decisions. The present tense of the feature:
  what it does, the flow, the states, the invariants, the traps that are
  still true. No history, no "this was changed". Logic, not code: a path is a
  pointer, a function body is not. Where the part talks to another
  repository — an endpoint it serves or calls, an event, a schema — add the
  `## Interfaces` section, one `provides:` or `consumes:` line each, named
  the way the code names it. Name the file for the feature as the product
  calls it, the same name another team's repository would use, because the
  file name is the feature's id across the tree. Dispatch one subagent per
  design doc where there are several — each gets the part, the paths to
  read, the template and these rules — and write the map yourself while they
  work.
- **`docs/decisions/NNNN-<slug>.md`** — the choices the code and the history
  actually show: a comment that says why something is done the hard way, a
  commit message that argues for an approach, a design note in the
  repository, a pattern that was clearly abandoned. All eight sections
  filled, numbered from `0001` upward. Two rules that matter here:
  - Where the reason is not stated anywhere and you worked it out from the
    code, say so in `Rationale`, in those words: *inferred from the code, not
    stated*. An alternative nobody considered is not an alternative — leave
    the section honest rather than full.
  - Only real choices. A bug fix that follows the existing design is not a
    decision, and neither is a convention nobody decided. Ten sound records
    are worth more than forty invented ones.
  `Run:` is the commit the decision came from, or `manual` where the history
  does not say.
- **`CLAUDE.md`** — where there is none, write one: the record table from the
  reference, this repository's real commands from step 2, its commit
  conventions, and the rules that hold everywhere in it. Where there is one,
  **append the record section only** and leave every other line untouched.
- **`docs/plans/.gitignore`** — the single line `*`, so the pipeline's own
  node finds it already there and the plan files never reach a commit.
- **`CHANGELOG.md`** — where there is none: `## Unreleased`, then one heading
  per release the history actually shows (`git tag`, release commits), newest
  first. Invent nothing; a repository with no releases gets `## Unreleased`
  and nothing else.
- **`docs/specs/`** — leave it to the first run. A spec is what one run set
  out to do, and writing specs for work that is already finished is writing
  fiction.

## 5. Report before anything else happens

Show the file list with line counts, what you did not write and why (already
there; no decision the history supports), and say in as many words: **nothing
has been committed**. The user reviews what is on disk before it goes
anywhere.

## 6. Teach it to the team's memory

This writes to the whole team's memory, and it needs commits, because
`gate teach` reads a range of history. So ask, with AskUserQuestion: commit
these and teach them, or stop here.

**If they say no**, print what they can run later, and finish.

**If they say yes**, put the work on a branch of its own —
`git switch -c gate-init` — and then, for each feature, in turn:

1. Commit that feature's design doc together with the decision records that
   belong to it: subject `docs: <feature> — how it works today, and the
   decisions behind it`, and in the body a `Documents:` line naming the
   files. Nothing else in the message: no trailer, no signature, no
   "Co-Authored-By", no "Generated with" line.
2. Write the account for it to a file of your own, e.g.
   `$TMPDIR/gate-init-<feature>.json`, with the seven fields `/gate:teach`
   uses — `task`, `plan`, `decisions`, `implementation`, `verification`,
   `pitfalls`, `evidence`. For an init the shape is:
   - `task`: what this part of the repository is for, as the person who
     asked for it would have put it, and that it is being recorded as it
     stands before gate;
   - `implementation`: the design doc's *How it works*;
   - `decisions`: one paragraph per decision record, saying which reasons
     are inferred;
   - `pitfalls`: the design doc's *Pitfalls*;
   - `verification`: how this part is tested today, with the command;
   - `plan`: how it is put together, in order, where that is not already the
     implementation;
   - `evidence`: the paths you read and the commit range.
3. Teach that one commit:

       node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" teach --base HEAD~1 --account-file <file>

   `HEAD` is the commit you just made and `HEAD~1` is the one before it, so
   the range is exactly this feature and nothing else.
4. Say what the recorder wrote — the decisions, and the feature it filed them
   under — and go on to the next.

One feature at a time, and never all of them in one teach: a teach records
**one** feature, so a single teach of everything would file the whole
repository under one card and the catalogue would be useless to a sibling
team asking how you built a thing.

The map, `CLAUDE.md`, the changelog and the `.gitignore` go in one last
commit and are not taught: they are the skeleton, not a feature.

Nothing is pushed and no merge request is opened. The branch is the user's.

What can go wrong, and what it means:

- **no remote** — the decisions are recorded without a repository name, so a
  path in them means less than it could. Say so; it does not stop anything.
- **`already worked on this branch`** — a run recorded this range before. Add
  `--force` only if the user asks for it.
- **a design doc that will not fit** — the recorder reads 6 000 characters of
  one document and 60 000 of all of them together. A design doc over that is
  too long to be read by anyone either; cut it to what is true and
  load-bearing.
- **`the recorder failed`** — say what it said. It retries on its own, and
  the run's page has "Record again".

## 7. Say what comes next

- `/gate:design` — a pipeline for this repository, on top of the shipped one.
- The first `/gate:run`, which will write the first file in `docs/specs/`.
- From now on the record is kept by the pipeline and by `CLAUDE.md`: a change
  that alters behaviour updates its design doc, a real choice writes a
  decision record, and the reviewer sends back work that does not.
- Once these documents are on the repository's base branch and the
  repository is connected on the gate's Repos page (with its team), the gate
  reads them itself, by code, on a timer. Every team in the tree then finds
  the design docs and the interfaces they list, whether or not this
  repository's own work ever runs through gate. A repository nobody connected
  is only in memory through what is taught.
