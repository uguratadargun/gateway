# 0044. A repository that does not publish is read from its origin

Status: accepted
Date: 2026-09-23
Run: manual

## Context

`gate ask` read a repository only from its publication remote (0003). The publication remote is also the setting that lets gate push a run's branch, and it is unset by default so that nothing starts pushing on its own. A repository connected without one could not be asked about at all. On the live gate an android developer asked how the desktop app handles sync messages and was told `"ulak-desktop" does not publish, so nothing in it can be read from here`, even though desktop's base branch was on its GitLab origin and the record index had read it from there minutes earlier. The index already fell back to `origin`. `ask` did not, so the two reads disagreed about the same branch.

## Decision

A repository is read from its publication remote, or from `origin` when it names none. This holds for a question about a branch, a tag or a commit, and for the record index. A question about a run still needs the run's branch to have been published, because only gate could have pushed it.

## Rationale

Reading is not publishing. Leaving the publication remote unset says "gate never pushes here". It does not say "nobody pushes here". A team's base branch is on its origin because the team put it there, and that is exactly what "work that is published" meant in 0003. Tying readability to the push setting made a team choose between letting gate push run branches and being askable at all, and the default answer made every newly connected repository unaskable.

One rule for both readers means that a document recall shows can also be asked about.

## Alternatives

Keep the refusal and tell people to set a publication remote. That works, but it switches on pushing as a side effect of wanting to be read. It also lets every repository connected later fail the same way until someone notices.

Read from gate's own checkout without fetching. The checkout is only as new as the last fetch, and an answer has to name a commit the remote actually holds.

## How it works

`readRemote` in the repository store returns the publication remote, or `origin`. `resolveAskSource` resolves a ref against it with `ls-remote` and fetches the commit from it. The record index's `resolveBase` uses the same function. A checkout with no `origin` fails at `ls-remote` and is reported as `source_unavailable`, naming the repository and the remote it tried. `fromRun` is unchanged: a run is answered at the commit its publication was verified at.

## Consequences

Any branch or tag a team pushed to its origin can be asked about by the family, not only the base branch. The family boundary is unchanged, and it is what limits who may ask.

A repository whose origin needs credentials that the server's checkout lacks now fails at `ls-remote` with git's own message, where it used to fail with the publication message.

## Touches

- `src/repos/store.ts`
- `src/orchestration/ask.ts`
- `src/memory/record-index.ts`
- `tests/ask.test.ts`

## Supersedes

0003 in part: the source was the publication remote only. That a question resolves to one commit, that the answer names it, and that unreachable is never read as "not built" all still hold.
