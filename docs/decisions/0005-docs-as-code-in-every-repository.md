# 0005. The repository keeps its own record, and the pipeline writes it with the code

Status: accepted
Date: 2026-09-16
Run: manual

## Context

Three questions kept coming up about every repository a team works on, and
none of them had a place to be answered: how does this feature work, which
decision made it so, and when something breaks, which decision is the one
that has to change. gate's memory already held the answers in shape — a
decision record with context, decision, rationale, alternatives, how,
consequences and touches, and a per-team implementation summary with its
pitfalls — but only in the database, readable through recall and the
dashboard. Nothing was written into the repository. The planner was told in
so many words that "there is no separate document"; the plan file was kept
out of the commit on purpose, so that the merge request carried only the
change. A person opening the repository six months later, or a colleague
from another team, found the code and the commit log and nothing that said
why.

The ask was for markdown in each repository: how the system and each
feature works, what was built, and a way back from a fault to the decision
behind it — kept current with every change, not written once.

## Decision

Every repository keeps four kinds of document, each answering one question,
in fixed places: `docs/design/<feature>.md` for how a feature works today,
`docs/decisions/NNNN-<slug>.md` for why, `docs/specs/YYYY-MM-DD-<topic>.md`
for what a run set out to do and what counted as done, and `CHANGELOG.md`
for what shipped when, with `docs/ARCHITECTURE.md` as the map. The pipeline
writes them with the code and holds every change against them: the planner
names them in a `## Documentation` section, the implementer writes them as
the plan's last task and copies the finished plan to `docs/specs/`, the
reviewer and verifier treat a document left untrue as a finding. The
markdown in the repository is the source; memory is the index of it. The
recorder reads decision records and design docs from the run's diff and
records them with the file's path among the touches, so a search by path
finds the record a file made, and recall cites the file for the next planner
to read.

## Rationale

The two things that make documentation rot are having no fixed place for
each kind of statement and having nobody whose job it is to change it. A
design doc that also carries history stops being read; a decision record
that gets edited stops being trusted. Separating the present tense (design)
from the past (decisions) from the intent (specs) from the release line
(changelog) gives each file one lifetime, and the pipeline's existing loop —
plan, implement, verify, review, with feedback routed back to the
implementer — is already the mechanism that makes a missing update a
blocking finding rather than a request.

Keeping the markdown as the source, rather than exporting it from the
database, is what makes it reviewable in the merge request, readable with
`git blame`, and true in a checkout with no gate at all. Memory keeps what
it was built for: search across teams and repositories, and a brief before
planning. The decision record's sections are the memory record's fields in
the same order, so nothing is translated between them.

## Alternatives

Export the database to markdown after each run. Rejected: the recorder runs
after the run has settled and the worktree may be gone, so the export could
not land in the same merge request as the change, and a document nobody
reviewed would be the one people read.

Commit the plan file and call the directory `specs/`. Rejected: a plan has
revisions, and each pass writes its own file so that the implementer's
commits keep their names; committing every revision fills the repository
with working files. Copying the final plan once, when the last task is
committed, keeps the spec and drops the noise, and leaves decision 0004's
reason standing.

A documentation agent in the pipeline. Rejected: the shipped planner,
implementer and reviewer already have the context — the plan, the diff, the
task — and a separate node would have to be handed all of it again. It also
contradicts how `/gate:design` extends a pipeline: with command nodes and at
most a specialist reviewer, never a copy of a shipped agent.

Turkish for the documents, since the team reads it. Rejected in favour of
English: the code, the commits and the agent prompts are English, and a
design doc in one language next to a prompt in another is two conventions.

## How it works

The planner reads `docs/ARCHITECTURE.md` and the design doc of the feature
the task touches before the code, and a decision record its task would
reverse becomes an assumption in the plan and a new record in its last task.
The plan's `## Documentation` section names the design doc to rewrite and
whether the change is a decision — a real choice, or an earlier record
reversed — or `none` with the reason. When it is not `none`, the last task
is `Task N: Documentation`, and the implementer commits it like any other,
with the record's path in the commit body. When the last task is committed
and the checks are green, the implementer copies the plan as it stands to
`docs/specs/`, with a status block naming the branch, the decision records
and the design docs, and commits it as `Spec: <topic>`. Its summary carries
a `Documents:` line, which the pipeline's commit node puts in the commit
body.

The reviewer holds the change against the record as a fifth thing, after
the task, the plan, the code and the claims: behaviour changed while the
design doc that describes it stayed, a decision record the plan named and
the diff lacks, an empty section, a function body pasted where logic should
be, a design doc narrating what changed, a run with no spec — all Important,
routed to the implementer without a new plan. The verifier checks the same
files exist with the sections named. The quick pair keeps a design doc's
sentence true when it changes the behaviour, and sends anything that would
need a decision record to the full pipeline.

The recorder splits the run's stored diff by file, keeps the added lines of
files under `docs/decisions/` and `docs/design/`, and puts them in its
prompt before the steps, reserved from the budget first. A decision record
in the diff is recorded as one decision with its sections as the fields and
its own path among the touches; a design doc's Summary, How it works and
Pitfalls become the feature's implementation summary and pitfalls. Recall
prints the path on the decision's line when a touch is under `docs/`, so the
planner opens the file. The investigator follows `git blame` to the commit,
the commit body to the record, the record to the reasoning.

## Consequences

The prompts of nine shipped agents grew, and a change to a shipped prompt
does not reach a running gate on its own: a team's agents are seeded once,
and `npm run defaults:restore -- --refresh` rewrites them from the new
defaults with a backup. The live deployment has to do that before the next
run sees the `## Documentation` section.

A run now makes two or three more commits — the documentation task, the
spec, and sometimes a superseded-status line — and a merge request carries
them. That is the point, and it is also more for a reviewer to read.

Backfilled records (0001 to 0004) were written from code comments, commit
messages and the earlier Turkish notes, after the fact; their dates are the
dates of the commits they describe, not of their writing. Later records are
written by the run that made the decision, and are the better kind.

The convention lives in `plugins/gate/reference/docs.md` and ships with the
plugin, so `/gate:design` reads it for every repository. A repository with a
layout of its own has to say so in the task or in a command node; the
shipped agents look in `docs/` and nowhere else.

The version stayed at 0.37.0 in this change. The plugin's `reference/` and
`commands/` changed, so the next release has to bump it before the plugin
update carries these files.

## Touches

- `plugins/gate/reference/docs.md`
- `plugins/gate/commands/design.md`
- `plugins/gate/commands/teach.md`
- `src/agents/defaults.ts`
- `src/memory/extract.ts`
- `tests/defaults.test.ts`
- `tests/memory-extract.test.ts`
- `tests/memory-teach.test.ts`
- `docs/ARCHITECTURE.md`
- `docs/design/`
- `docs/decisions/`
- `docs/specs/`
- `docs/plans/.gitignore`
- `CHANGELOG.md`
- `README.md`
- memory
- dev-workflow

## Supersedes

0004 — the plan file is still never committed; its final revision is now
copied to `docs/specs/` when the last task is committed.
