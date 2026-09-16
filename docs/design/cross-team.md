# Cross-team collaboration

## Summary

Several teams build one product in codebases of their own. A person on one of
them finds out what another's code does without waiting for anybody on that
team to be awake: the question is answered by reading their published code at
one fixed version, and the answer names the files it came from. When a team's
plan cannot live with another team's decision, the disagreement is written
where that team's next plan will read it. And work several teams have a hand in
gets a name of its own, so what is unsettled between them outlives the runs
that served it.

## How it works

### Asking another team

A question names a repository (its canonical name or its connected id) and
optionally a version: a branch, a tag, a commit, or a run whose published
branch is the thing being asked about. Unset means the repository's base
branch.

Everything resolves to **one commit before anything is read**, and that commit
is quoted back, so the same question asked twice either gives the same answer
or says why the source moved. A branch is resolved once, to what the remote
holds now; a run is answered at the commit its publication was verified at, not
where its branch points today. What makes a repository readable at all is
publication: a run's branch is pushed to its repository's publication remote
when the run ends, within a branch glob, and the commit recorded is what the
remote reports holding afterwards, never the local head.

Three refusals, each a different fact, never conflated. **Outside the family**:
the asker's team tree is the boundary memory uses, and a repository outside it
is refused in the words a misspelled name gets, so the shape of a refusal
confirms nothing about another company. Which team a repository is in is set on
the Repos page; one nobody has claimed is outside no family and answers
everyone. **Not published**: a branch on
somebody's laptop cannot be read from here, so the answer names the branch that
has to be pushed. **Not at that commit**: the reviewer read the tree and found
nothing under the names it searched, which is narrower than either.

The commit is fetched here and memory read **at it**: decisions whose work is
in that commit's history hold, the rest describe later or unmerged work, and
both reach the reviewer labelled, as a brief, never as the answer. A read-only
agent reads the source and answers with its files; read-only is the tool list,
not a sentence in a prompt. The run is started against the checkout's path, so
it inherits no publication and pushes nothing to the other team's remote.
Nothing is cached: the asker pays a run each time.

### Objecting

The objection record — its states, who may close it, how the other team's
recall surfaces it — is in [memory](memory.md); what belongs here is how one
comes to be written. The planner's own output carries it, and the engine
routes: a plan naming a conflict reaches the node that puts it to the person
before any question or the plan itself.

The server writes it only against the run's pinned definitions: the node must
exist, be an agent and declare the field, and a node reporting an answer must
be one the graph let read that objection. A run cannot object to itself or
outside its family, and a re-sent batch makes one row and one transition.

### The task ledger

A task is opened by a person: an owning team, a title, a status, visible to
that team's family. A run is filed under one when it starts, a continued run
inherits it, and every objection that run raises is stamped with it, so the
task shows what is unsettled across the teams working on it.

It is **a label, never a key**. Nothing is required to have one; nothing is
found only by one. An objection from a run that named no task reaches the team
it was raised against just the same, because the paths and the feature carry
it. A task is closed when a person says the work is done — no run ending closes
it, and closing leaves every objection under it standing.

## Key files

- `src/orchestration/ask.ts` — a question resolved to one commit, the family
  check, the fetch, memory split by that commit's history
- `src/orchestration/tasks.ts` — the task record and the runs filed under it
- `src/memory/issues.ts` — objections and the answers people give them
- `src/executions/record.ts` — an objection written with the step that raised
  it; answers matched to it
- `src/repos/publish.ts` — the push, the policy, the verified commit
- `src/app/api/v1/ask/route.ts`, `src/app/api/tasks/route.ts` — the endpoints
- `src/app/tasks/page.tsx` — the work's page
- `src/agents/defaults.ts`, `src/workflows/defaults.ts` — the read-only
  reviewer, the ask pipeline and the objection nodes
- `plugins/gate/commands/ask.md` — `/gate:ask`

## Pitfalls

- An unreachable source means nobody published, not that the work was never
  done; reporting it as "they have not built it" is the failure this guards.
- An answer is true of one commit; restating it without the commit is a
  different claim, and usually a wrong one.
- Resolving or withdrawing an open objection has no surface yet: a person can
  only refuse one while it is still unanswered, so an open one stands in the
  other team's recall until somebody changes the row.
- Closing a task settles nothing raised under it, and a task lists only the
  objections whose runs named it.
- A run cannot open a task; it can only be filed under one that already exists.
- A replacement ask pipeline whose agent holds a write, edit or command tool
  turns a question into a change to someone else's checkout.

## Decisions

- [0008 — A task is a label, never a key](../decisions/0008-a-task-is-a-label-never-a-key.md)
- [0003 — Ask answers from one commit](../decisions/0003-ask-answers-from-one-commit.md)
- [0002 — Objection record instead of messaging](../decisions/0002-objection-record-instead-of-messaging.md)
