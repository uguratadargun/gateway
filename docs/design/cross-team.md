# Cross-team collaboration

## Summary

Several teams build one product in codebases of their own. A person on one of
them finds out what another's code does without waiting for anybody on that
team to be awake: the question is answered by reading their published code at
one fixed version, on the asker's own machine, and the answer names the files
it came from. What each
team's repository says about itself — how a feature works, what it provides
and consumes — is read from its base branch for everyone in the tree. Work
another team is doing right now is shown before anyone plans the same thing.
When a team's plan cannot live with another
team's decision, the disagreement is written where that team's next plan will
read it. And work several teams have a hand in gets a name of its own, so
what is unsettled between them outlives the runs that served it.

## How it works

### Asking another team

A question names a repository (its canonical name or its connected id) and
optionally a version: a branch, a tag, a commit, or a run whose published
branch is the thing being asked about. Unset means the repository's base
branch.

Everything resolves to **one commit before anything is read**, and that commit
is quoted back, so the same question asked twice either gives the same answer
or says why the source moved. A branch is resolved once, to what the remote
holds now under exactly that name — `refs/heads/<name>`, then
`refs/tags/<name>` read as the commit the tag points at, never another ref
whose name merely ends the same way; a run is answered at the commit its
publication was verified at, not where its branch points today. A commit is
taken whole; an abbreviation only when the gate's checkout already has the
commit it names, since a remote cannot be fetched from by one. A repository is read from its publication
remote, or from its `origin` when it names none: not publishing means gate
never pushes there, not that nobody does, and the base branch its team pushed
is readable either way. A run's branch is different. Only gate could have
pushed it, so it is readable once the run has published it to the publication
remote, within a branch glob, and the commit recorded is what the remote
reports holding afterwards, never the local head. The publication is the
client's report, and it reaches `git fetch` on the server, so the server
stores it only as a `refs/heads/…` name git would accept and a full commit;
anything else is stored as a failed publication. Every git call built from a
stored or asked-for value puts `--end-of-options` in front of it.

Three refusals, each a different fact, never conflated. **Outside the family**:
the asker's team tree is the boundary memory uses, and a repository outside it
is refused in the words a misspelled name gets, so the shape of a refusal
confirms nothing about another company. That holds however the repository is
reached: a run in the asker's family that worked in a repository outside it —
its client named that repository by the origin it reported — is answered as a
run in a repository the gate has no record of. Which team a repository is in is set on
the Repos page; one nobody has claimed is outside no family and answers
everyone. **Not published**: a branch on
somebody's laptop cannot be read from here, so the answer names the branch that
has to be pushed. **Not at that commit**: the reviewer read the tree and found
nothing under the names it searched, which is narrower than either.

The commit is fetched into the gate's own checkout of the repository, and
memory is read **at it**: decisions whose work is in that commit's history
hold, the rest describe later or unmerged work, and both reach the reviewer
labelled, as a brief, never as the answer. The gate then records an **ask**:
the asking team and person, the repository, the ref, the commit, the question,
and an expiry a day later. It answers with the ask's id, the source and the
brief, and starts nothing.

The reading is the asker's. `gate ask` takes that answer and begins an
ordinary run of the team's `ask` workflow in the asker's own Claude Code
session, with the question, the source, the ref, the commit, the ask's id and
the brief as its inputs; `/gate:ask` drives it the way `/gate:run` drives any
run. The workflow is one agent node, `source-review`, ending on `done` or on
`absent` when nothing at the commit matched, with no workspace and no command
node. The session does that node itself, and its memory tools are the `gate
memory` commands.

The other team's repository never lands on the asker's disk. The session reads
it through three views of the ask's commit, served by the gate: `gate source
tree` lists the files under a path, two levels deep unless told otherwise;
`gate source grep` gives the lines matching a pattern as `path:line:text`;
`gate source file` prints one file with line numbers. Each is `git ls-tree`,
`git grep` or `git show` against the commit in the gate's checkout, so nothing
is checked out on the server and nothing can be written through them. A
listing stops at 500 entries and skips dependency and build directories, a
search at 100 matches, a file at 200 KB; a pattern is always passed to git as
a pattern, never as an option. Every read checks again that the ask is the
caller's team's, that it has not expired, and that the repository is still in
the caller's family, and every refusal is the same "no ask", whatever the
reason. A path with `..`, a leading `/` or a `:` is refused before git sees
it.

Nothing is cached: each question is a new ask and a run of the asker's own.
An ask can be read for a day; after that, asking again makes a new one and
resolves the ref again.

### Objecting

The objection record — its states, who may close it, how the other team's
recall surfaces it — is in [memory](memory.md); what belongs here is how one
comes to be written. The planner's own output carries it, and the workflow's
edges route: a plan naming a conflict reaches the node that puts it to the person
before any question or the plan itself. The objection is the entry in the
planner's `conflicts`, not the key beside it: a key with no entry is nothing
the server can file or the person can be asked about, and the run carries on
to the plan.

The server writes it only against the run's pinned definitions: the node must
exist, be an agent and declare the field, and a node reporting an answer must
be one the graph let read that objection. A run cannot object to itself or
outside its family, and a re-sent batch makes one row and one transition.

Recall shows an objection to the planner working in the same paths, which is
the right moment for a run and the wrong one for a person: a team that does not
plan in those files for a month never learns anybody objected. The Objections
page is the other half — the same rows found by team rather than by code, split
into what stands against this team, what it raised, and what two other teams in
its tree are disagreeing about. It is the only place an objection from a run
that named no task is visible at all, and it says how many answers never
reached the server, so an empty list is not read as agreement.

It is closed by the side it belongs to, from the dashboard and nowhere else.
The team whose decision was objected to **resolves** it, saying what was done —
that note is what the objecting team's next recall shows. The team that raised
it **withdraws** it. Neither may do the other's, and an objection a team is on
neither side of reads as absent. No run closes one: a run finishing on either
side is not evidence the other team was satisfied. A closed objection leaves
both teams' recall and keeps its row, with who closed it and why.

### Work in flight, and who integrates what

Memory is written when a run ends, so on its own it cannot say that another
team started the same feature this morning. The runs going right now can: a
search's words are matched against the tasks of other people's running runs
in the tree, and recall puts the ones that share enough of them first in the
brief, before any decision, with the person running each. Nobody is messaged:
an overlap is seen by whoever recalls in the same words. The match is shared
words cut to a six-letter stem and counted, never a model. `gate memory activity` lists everything in flight in the tree
([0039](../decisions/0039-work-in-flight-is-part-of-recall.md)).

Between repositories, the question is usually not "what did they decide"
but "who uses this, and how did they wire it in". A design doc's
`## Interfaces` section says what its feature provides and consumes. The
[record index](record-index.md) keeps each line, and a search whose words
name an interface returns every repository on each side of it, with the
design doc where each says how. A search in words reads every repository
of the tree, and a path search stays in the asker's own
([0037](../decisions/0037-words-read-every-repository-paths-stay-in-their-own.md)).
The decisions a person makes in another team's repository are that team's
record, with the person's team kept as the author
([0036](../decisions/0036-a-decision-belongs-to-the-repositorys-team.md)).

### The task ledger

A task is opened by a person: an owning team, a title, a status, visible to
that team's family. Work is filed under one when it is recorded, a continued
run inherits it, and every objection a filed run raises is stamped with it, so
the task shows what is unsettled across the teams working on it.

Every way work reaches the gate takes the same `--task-id`: a run through
`gate begin`, an ask through `gate ask`, which begins one, and `gate teach`,
which is how a branch finished before the task existed gets under it. The id
is checked against the caller's family before anything is stored, in one
wording for all of them — a task the caller cannot see is not a task. Teaching a branch a second
time takes a task the first teaching did not name and keeps the one it did;
naming none is never a way to unfile it.

It is **a label, never a key**. Nothing is required to have one; nothing is
found only by one. An objection from a run that named no task reaches the team
it was raised against just the same, because the paths and the feature carry
it. A task is closed when a person says the work is done — no run ending closes
it, and closing leaves every objection under it standing.

## Key files

- `src/orchestration/ask.ts` — a question resolved to one commit, the family
  check, the fetch, memory split by that commit's history
- `src/orchestration/ask-source.ts` — the ask record, its expiry and the check
  every read repeats, and the three read-only views of its commit
- `src/orchestration/tasks.ts` — the task record and the runs filed under it
- `src/memory/activity.ts` — the tree's runs in flight, matched by words
- `src/memory/record-index.ts` — interfaces and design docs across the tree's repositories
- `src/memory/issues.ts` — objections and the answers people give them
- `src/executions/record.ts` — an objection written with the step that raised
  it; answers matched to it
- `src/repos/publish.ts` — the push, the policy, the verified commit
- `src/client/cli.ts` — `gate ask`, which begins the ask run, and `gate
  source tree|grep|file`
- `src/client/cli.ts`, `src/client/step.ts`, `src/memory/teach.ts` — the ways
  work names the task it serves
- `src/app/api/v1/ask/route.ts`, `src/app/api/v1/ask/[id]/` (`tree`, `grep`,
  `file`), `src/app/api/tasks/route.ts`,
  `src/app/api/issues/route.ts`, `src/app/api/v1/memory/teach/route.ts` — the
  endpoints
- `src/app/tasks/page.tsx` — the work's page
- `src/app/objections/page.tsx`, `src/components/objection-card.tsx` — what is
  unsettled for a team, and the two ways one is closed
- `src/agents/defaults.ts`, `src/workflows/defaults.ts` — the source reviewer,
  the ask workflow and the objection nodes
- `plugins/gate/commands/ask.md` — `/gate:ask`

## Pitfalls

- An unreachable source means nobody published, not that the work was never
  done; reporting it as "they have not built it" is the failure this guards.
- An answer is true of one commit; restating it without the commit is a
  different claim, and usually a wrong one.
- `git ls-remote <remote> <name>` matches by the end of a ref's name, so
  `main` also finds `archive/main`, which sorts first. The name is asked for
  as full refs and only an exact match counts.
- A value from a client or an asker that starts with `-` is an option to git
  (`--upload-pack=<command>` runs one). It is refused where it arrives and put
  after `--end-of-options` where it is used, both.
- An objection is closed by a person, from the dashboard, and nothing verifies
  the note: a resolution can be written while the code still disagrees.
- A withdrawal is quiet. The team objected to may have planned around it
  already, and all they see is that it is gone.
- Closing a task settles nothing raised under it, and a task lists only the
  objections whose runs named it.
- A run cannot open a task; it can only be filed under one that already exists.
- A run names its task when it starts and never again: nothing moves a
  finished run under a task opened later. A branch can be taught again to say
  so, but a run cannot be re-filed, so a task opened mid-flight shows only what
  started after it.
- The session doing an ask stands in a checkout of its own, which is a
  different repository. A reviewer that reads that checkout instead of `gate
  source` answers confidently about the wrong codebase.
- An ask's id is its whole grant: `gate source` with an id older than a day,
  or one another team made, answers "no ask", the same as a mistyped one.
- An ask is the asker's own run on their own Claude login; asking the same
  question twice costs it twice.
- An overlap is told to nobody. Two teams starting the same work see each
  other only when one of them recalls in the same words.
- An interface is matched by its name as written. Two teams writing the same
  endpoint two ways are two interfaces.

## Decisions

- [0048 — A question to another team is read on the asker's machine, from the commit the gate fixed](../decisions/0048-ask-is-read-on-the-askers-machine.md)
- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0044 — A repository that does not publish is read from its origin](../decisions/0044-a-repository-that-does-not-publish-is-read-from-its-origin.md)
- [0039 — Work in flight is part of recall, and an overlap is told to both people](../decisions/0039-work-in-flight-is-part-of-recall.md)
- [0037 — Words read every repository of the tree, paths stay in their own](../decisions/0037-words-read-every-repository-paths-stay-in-their-own.md)
- [0036 — A decision belongs to the repository's team](../decisions/0036-a-decision-belongs-to-the-repositorys-team.md)
- [0016 — An objection is closed by the side it belongs to](../decisions/0016-an-objection-is-closed-by-the-side-it-belongs-to.md)
- [0008 — A task is a label, never a key](../decisions/0008-a-task-is-a-label-never-a-key.md)
- [0003 — Ask answers from one commit](../decisions/0003-ask-answers-from-one-commit.md)
- [0002 — Objection record instead of messaging](../decisions/0002-objection-record-instead-of-messaging.md)
