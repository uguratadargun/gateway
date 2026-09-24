# 0048. A question to another team is read on the asker's machine, from the commit the gate fixed

Status: accepted
Date: 2026-09-24
Run: manual

## Context

`gate ask` answers one team's question about another team's code from one fixed commit (0003, 0044). The gate resolved the commit, fetched it into its own checkout, read the asker's memory at that commit, and then ran the `ask` workflow itself: a worktree at the commit, and a `source-review` agent on gate's own loop, on the gate's Claude logins. The asker's CLI waited for the answer.

With no Claude login on the gate (0046) and no runs on the server (0047), the review has nowhere to run. The asker's own Claude can read code. What it does not have is the other team's repository, which is the reason the gate does the fetching.

## Decision

The gate still resolves the commit, checks the family, fetches, and reads memory at the commit. Instead of starting a run, it records an ask: the asking team, the repository, the commit, the question, and an expiry a day later. It answers with the ask's id, the source and the memory brief.

The asker's CLI starts an ordinary run of the `ask` workflow in their own session, with those as its inputs. The `source-review` node is the session's to do. It reads the other team's repository through three read-only views of the ask's commit, served by the gate: the files under a path, the lines that match a pattern, and one file with line numbers. On the command line they are `gate source tree`, `gate source grep` and `gate source file`.

Every read checks again that the ask is the asking team's, that it has not expired, and that the repository is still in the asking team's family. Every refusal is the same "no ask" answer. A path that leaves the repository is refused before git sees it.

## Rationale

The asking team already has a Claude session, and that session is the right reader: the person who asked is watching it read. The other team's repository must not follow the question onto the asker's disk. The views serve exactly what an answer cites, a listing, a match or a file, at the one commit the answer is about. Nothing is cloned and nothing can be written.

An id with a day's life and a family check on every read makes an ask a question and not a standing grant. A repository that moves to another company between the ask and the read stops being readable at once.

Reading at the commit with `git ls-tree`, `git grep` and `git show` means no worktree is cut on the server, and the answer cannot drift with whatever the gate's checkout happens to have checked out.

## Alternatives

**Run the review on the server on a provider model.** It was tried in effect: with the `sonnet` tier pointed at a hosted GLM, an ask took eight to twelve minutes, against five on Claude with correct citations. It would also keep a server-side runner alive for one workflow.

**Send the asker a bundle of the repository at the commit.** It is simpler to serve, but the whole of another team's code lands on the asker's machine for one question, and stays there.

**Answer from memory alone.** A decision found by shared words is not an answer, and 0003 exists to prevent exactly that.

## How it works

`POST /api/v1/ask` returns `ready` with the ask's id, or the same `source_unavailable` and `not_found` answers as before. `gate ask` then pins and begins the team's `ask` workflow with the question, the source, the ref, the commit, the ask's id and the memory brief, and prints the first instruction. `/gate:ask` drives it with the `/gate:run` protocol. The workflow is one agent node and two terminals, `done` and `absent`, and it has no workspace. The reviewer's prompt names the three commands with the ask's id in them. Its tools are the memory ones.

The views cap what they return, as the file tools did: 500 entries in a listing, 100 matches, and 200 KB of a file. A listing skips dependency directories. A pattern is always passed to git as a pattern, never as an option.

## Consequences

An ask takes the asker's own Claude time and shows up as their run, recorded and read by the recorder like any other run.

An ask can be read for a day. After that `gate source` answers "no ask", and asking again makes a new one, which resolves the ref again.

The workflow's inputs changed, so a team's own copy of the old `ask` workflow must be restored from the shipped one.

## Touches

- `src/app/api/v1/ask/route.ts`
- `src/app/api/v1/ask/[id]/read.ts`
- `src/orchestration/ask-source.ts`
- `src/lib/db.ts`
- `src/client/cli.ts`
- `src/client/api.ts`
- `src/workflows/defaults.ts`
- `src/agents/defaults.ts`
- `plugins/gate/commands/ask.md`
- `docs/design/cross-team.md`

## Supersedes

none
