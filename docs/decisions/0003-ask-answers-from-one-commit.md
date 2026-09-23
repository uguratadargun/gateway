# 0003. Ask answers from one commit

Status: superseded by 0044
Date: 2026-09-15
Run: 814ac19

## Context

The second need in 0002: the server team's run wants to know how desktop handled a thing in code, and nobody on desktop is awake. Until this, an answer could come from two places only — the team's memory, decision cards written by the recorder, which say what was decided and not how the code reads; and the model's impression of a repository it had not opened. Neither can be checked against a file. The 0002 design asked for a short-lived, read-only run in the other team's repository, with mandatory citations and an explicit `--as-of`, and named the prerequisite: gate had no registry of repositories by URL and no team↔repository link, so it could not know what to read, or fetch it.

0.37.0 built the pieces around it — a publication target on a repository record, a run's branch pushed there when it finishes, a run's definitions pinned when it begins. This decision is the ask itself.

## Decision

`gate ask "…" --repo host/owner/name` (or `--run`, `--ref`, `--commit`) resolves the request to one fixed commit on the repository's publication remote, fetches it, and has a read-only review agent read the repository at that commit. The answer names the commit it was read at and the files each part came from. Work that is not published is not reachable, and the answer says so (`source_unavailable`, naming the branch that has to be published) rather than saying the feature was not built. When nothing at the commit matches the question, the answer says that, in those words (`absent`).

## Rationale

An answer that cannot name a commit is a guess with a citation format. Everything here follows from making the commit the unit of truth.

A moving branch name is not a source. It is resolved once, to the commit it points at now, and that commit is quoted back, so the same question asked twice either gives the same answer or says why the source moved.

Unpublished work is not reachable. A branch in a worktree on somebody's laptop cannot be read from the server however much gate knows about it, and pretending otherwise is how "the feature was never built" gets said about a feature that was built last Tuesday. Unreachable is its own answer, with the branch that needs publishing named in it. "Not built" is a different claim and usually a wrong one, so the two are never conflated; nothing at that commit matching is narrower still, and says so.

Read-only is the tool list, not a sentence in a prompt. The reviewer is a gate-executor agent with `read_file`, `list_files`, `search_files` and the memory tools, and no write, edit or command tool. An instruction is a request; this is the guarantee the other team is owed about their checkout, and it has to hold at the layer that hands tools out rather than the layer that is asked nicely.

Memory is read here, at the commit, because only this side knows which commit: decisions whose work is an ancestor of it are labelled as holding, the rest as describing something else, and both go to the reviewer as a brief rather than as the answer. A search hit means words in common with the question, not an answer to it, so the source is read either way.

The family is the boundary, the same boundary memory uses. Being able to read a sibling team's decisions is not permission to read a third company's repository, and neither is knowing its name.

The run is started against the checkout's path and not its connected id, so it inherits no publication: a branch pushed into another team's remote because somebody asked a question would be a strange thing to find.

## Alternatives

Answer from memory alone, and run the source review only when memory has nothing — the three-tier answer 0002 sketched. Not taken as designed: a decision card is recorded on some run's work, and only the ask side knows whether that work is an ancestor of the commit being asked about. Memory is read at the commit and handed to the reviewer as a brief; the source is read every time.

Answer from the run's finish diff. A diff shows only the changed lines, and "how did they do it" usually wants the code around them; a diff also has no tree to cite a file in. Publication plus a fetch of one commit gives the whole tree.

Run the reviewer as a spawned Claude Code session, as 0002 suggested for its better repository tools. A spawned session brings its own tools, so read-only would be a sentence in a prompt. The gate executor's tool list is the guarantee, so the reviewer is a gate-executor agent.

Answer from a branch name as it stands. A branch moves; the answer would be true of a commit nobody recorded. The branch is resolved once and the commit is what is cited.

Return an unreachable source as an HTTP error. The request was fine, and the answer to it is "somebody has to publish that branch first". A 404 lands in the pile of things clients print as "request failed" and people read as "gate is broken". It comes back 200 with a status.

Message the other team, or an agent of theirs, and wait. Refused in 0002.

## How it works

The route (`POST /api/v1/ask`) validates the request and resolves the source for the asker's team: a repository by `host/owner/name` or its connected id, a run whose published branch is being asked about, a branch or tag on the publication remote, or an exact commit. The repository's team has to be in the asker's family. Resolution ends in one commit and the remote it is read from; a source that cannot be reached returns `status: source_unavailable` with the branch to publish, and a repository or run that does not exist returns `not_found`, both as 200.

The commit is fetched into a checkout. Memory is queried at that commit: decisions whose work is an ancestor are marked as holding, the others as describing something else, and both are rendered as a brief — an empty string when memory had nothing near the question, because an unresolved placeholder is an error and not a blank.

A run of the `ask` workflow is started against the checkout's path with `question`, `repo`, `commit` and `memory` as inputs. Its `base` node records the commit being read — the run's own record of which one it was, for the same reason `blame` has one. The `source-review` node reads and answers; an answer whose `certainty` is `absent` goes to the terminal "Not in the commit that was read", any other to "Answered". Nothing is written and nothing is run.

The answer carries the files it came from and the commit it was read at.

## Consequences

An answer costs a run when it is asked, and it is the asker's run. Nothing caches an answer: the same question at the same commit reads the source again. Memory is a brief to the reviewer, not a short-circuit.

Only published commits can be read. Work in progress on another team's machine is invisible until it is pushed to the publication target, and `source_unavailable` is the honest result until then; a team that wants its half-finished work askable has to checkpoint and publish it.

The `ask` workflow is shipped and a team may replace it, but a replacement has to keep the guarantee where it lives: an agent on that road with a write, edit or command tool turns a question into a change to someone else's checkout.

Adding a citation-free answer path — a summary from memory, a model's recollection — reverses the rule this record makes, and needs a record of its own.

## Touches

- `src/orchestration/ask.ts`
- `src/app/api/v1/ask/route.ts`
- `src/agents/defaults.ts` (SOURCE_REVIEW)
- `src/workflows/defaults.ts` (ASK)
- ask
- memory
- repos

## Supersedes

none
