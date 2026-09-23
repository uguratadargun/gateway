---
description: Set this repository up for gate — read it, write its architecture, design docs and decisions under the names the rest of your team tree uses, so every team's recall reads them
argument-hint: [what this repository is, if the code does not say]
---

<!-- No allowed-tools on purpose: reading a whole repository, writing its
     documents and, with the user's word, committing them, needs the
     ordinary set. -->

Who this machine is connected as, and to which team:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" whoami`

Whether the gate reads this repository — connected on its Repos page, whose
team, what it has read of it so far:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" memory repo`

The features the rest of the team tree already has — the ids a design doc is
named by:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" memory features`

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
show, and the skeleton the pipeline expects.

Memory does not need to be taught these files. Once they are on the
repository's base branch and the repository is connected on the gate, the
gate reads them itself, by code, on a timer. Recall then answers from them
for every team in the tree, including about everything built before gate.
Two things decide whether that reading is any use to a sibling team:

- **The names.** A design doc's file name is its feature's id across the
  whole tree: `offline-sync.md` here and `offline-sync.md` in the android
  repository are one feature, built twice, and the android team's recall
  finds this one. A second name for the same feature is two features that
  never meet.
- **The Interfaces section.** It says what this repository provides to the
  others and consumes from them, named as both sides write it.

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
  anyway — they are worth having — and say at the end that nobody else in
  the tree will read them until the machine is connected and step 6 is done.
- Read what `memory repo` printed. When the repository is not connected, or
  has no team, say so now, with its advice. The documents are still worth
  writing, but step 6 is where they reach anyone.
- Look for writing that is already there under other names: Markdown
  elsewhere under `docs/` (a feature write-up, a `docs/superpowers/specs/`
  design, a test plan), an ADR directory, a design section in the README.
  It is left where it is. It is the first thing you read in step 2, and the
  gate already reads Markdown under `docs/` as notes. The design docs you
  write point to it rather than repeat it or contradict it.

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
- where reasoning is already written down: the notes found in step 1, a
  README section, an `ADR`-like directory under another name, long comments
  that explain a choice, commit messages that argue for one. What those say
  outranks what you infer from the code, and where they disagree with the
  code, the code is what is true today and the note is history;
- what the rest of the tree already calls the same things. For each part you
  find, search the team tree's memory for it by its product name and its
  likely other names, in both languages the team writes in:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" memory search "<part, in words>"

  A feature in the catalogue above, or another repository's design doc,
  that is the same thing means this repository's design doc takes **that
  id** as its file name, even where this repository calls it something else
  internally. An interface another repository already lists — the server's
  `POST /v1/sync` — is written here under exactly that name.

Where the repository is large, send subagents: one area each, all at once,
each reporting what it found rather than pasting files back. Read the rest
yourself while they work.

## 3. Show what you would write, and let them choose

List the key parts you found, one line each. For each line give:

- its name, as the product names it (`offline sync`, `account pool`), not
  as a task (`refactor of sync`);
- the file name you will give its design doc;
- whether that name is an existing feature of the tree, and whose, or a new
  one.

A part is worth a design doc when someone maintaining this repository would
ask "how does this work"; a utility file is not.

Then ask with AskUserQuestion: write all of them, or a subset. Say plainly
what each line costs: one `docs/design/<feature>.md`, and no model call
after that, because the gate reads it by code. The size of the job is theirs
to decide. Also ask whether any file name should be different; a person on
the team knows which sibling feature is really the same one. Do not start
writing before they answer.

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
  `## Interfaces` section, one `provides:` or `consumes:` line each, under
  the name another repository already gives it where one does, else the way
  the code names it. The file name is the one agreed in step 3. Where a note
  already describes the part, read it first, keep what is still true, and
  list it under Key files as the older write-up, so a reader finds both.
  Dispatch one subagent per design doc where there are several. Each gets
  the part, the agreed file name, the paths and notes to read, the sibling
  design doc when there is one, the template and these rules. Write the map
  yourself while they work.
- **`docs/decisions/NNNN-<slug>.md`** — the choices the code and the history
  actually show: a comment that says why something is done the hard way, a
  commit message that argues for an approach, a design note in the
  repository, a pattern that was clearly abandoned. All eight sections
  filled, numbered from the next free number (`0001` in a repository that has
  none). Two rules that matter here:
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

## 6. Put it where the gate reads it

The gate reads a repository's base branch. Documents on a laptop, or on a
branch nobody merged, reach nobody. So ask, with AskUserQuestion: commit
these on a branch of their own, or stop here.

**If they say no**, print what they can run later, and finish.

**If they say yes**, put the work on a branch of its own —
`git switch -c gate-init` — and commit:

1. One commit per feature: its design doc together with the decision records
   that belong to it. Subject `docs: <feature> — how it works today, and the
   decisions behind it`, and in the body a `Documents:` line naming the
   files. Nothing else in the message: no trailer, no signature, no
   "Co-Authored-By", no "Generated with" line. One commit each keeps
   `git blame` on a design doc pointing at the one commit that explains it.
2. One last commit for the skeleton: the map, `CLAUDE.md`, the changelog and
   `docs/plans/.gitignore`.

Nothing is pushed and no merge request is opened. The branch is the user's,
and it reaches the base branch the way their other work does. Tell them what
happens then:

- **When the repository is connected** (what `memory repo` printed), the
  gate reads the merged documents on its next pass (every 15 minutes by
  default, or **Read repositories** on its Memory page). `gate memory repo`
  shows the documents it read. Nothing is taught, and no model is called.
- **When it is not connected**, connecting it on the Repos page, with its
  team, is the step that matters. Until then these documents reach nobody.

Teach only when the repository cannot be connected on the gate at all: the
server cannot fetch it, or it lives only on laptops. Then, and only with the
user's word, teach each feature commit on its own, never all of them in one
teach:

1. Write the account to a file of your own, e.g.
   `$TMPDIR/gate-init-<feature>.json`, with the seven fields `/gate:teach`
   uses:
   - `task`: what the part is for, recorded as it stands before gate;
   - `implementation`: the design doc's *How it works*;
   - `decisions`: one paragraph per record, saying which reasons are
     inferred;
   - `pitfalls`: the design doc's *Pitfalls*;
   - `verification`: how this part is tested, with the command;
   - `plan`: how it is put together, where that is not already the
     implementation;
   - `evidence`: the paths read and the commit.
2. Check out that commit and run:

       node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" teach --base HEAD~1 --account-file <file>

   A teach records one feature, so one teach of everything would file the
   whole repository under one card.

What can go wrong, and what it means:

- **`memory repo` says not connected, or no team.** Say it plainly: the
  documents are worth having, and they reach the rest of the tree once the
  repository is connected with its team.
- **A sibling's feature under a name this repository does not use.** Take
  the sibling's id anyway. The product name can differ inside the doc, and
  the file name is the join.
- **A name the user rejects in step 3.** Theirs wins. Say that the two
  features will not meet in recall until one of the files is renamed.
- **No remote.** The gate cannot name the repository, so it cannot connect
  or read it. Say so; the documents are still worth writing.

## 7. Say what comes next

- `/gate:design` — a pipeline for this repository, on top of the shipped one.
- The first `/gate:run`, which will write the first file in `docs/specs/`.
- From now on the record is kept by the pipeline and by `CLAUDE.md`: a change
  that alters behaviour updates its design doc, a real choice writes a
  decision record, and the reviewer sends back work that does not.
- Once the `gate-init` branch is merged and the repository is connected on
  the gate's Repos page (with its team), the gate reads the documents itself,
  by code, on a timer. Every team in the tree then finds the design docs and
  the interfaces they list, whether or not this repository's own work ever
  runs through gate. `gate memory repo` shows what it read.
