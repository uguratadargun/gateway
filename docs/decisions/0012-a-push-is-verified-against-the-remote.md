# 0012. A push is verified against the remote, and a failed one is not a failed run

Status: accepted
Date: 2026-09-16
Run: 5362915

## Context

Another team cannot read work that never left the machine that made it. Publishing a run's branch is what makes it readable, and `ask` (0003) answers from exactly one published commit — so what gate records about a publication is what a sibling team later fetches.

That puts weight on a step that is easy to get wrong quietly. A push reports success locally, and the local remote-tracking ref is written by the push itself, so it agrees with the push by construction. A remote that rewrote the ref, rejected it under a hook, or accepted it somewhere else would leave gate recording a commit nobody else can fetch, and the next team's question would be answered from a commit that does not exist for them.

## Decision

The commit recorded for a publication is the one `ls-remote` reports afterwards, never the local HEAD. The push is `HEAD:refs/heads/<branch>` with no `--force` and no `--set-upstream`. Publication is a step of its own: a push that fails is recorded as a publication error against a run that is otherwise finished, not as a failed run. A repository with no publication remote publishes nothing, and says so.

## Rationale

The verification is the whole point of the step. Anything short of asking the remote what it now holds is asking the pusher whether the push worked, which is the party that cannot answer it.

A non-fast-forward is a refusal, not something to resolve from here. Forcing would make gate the party that decided someone else's branch history was wrong, in a repository it does not own.

No upstream is set, because an upstream changes what `gate clean` treats as a disposable worktree. A publication that quietly made a worktree collectable would destroy work as a side effect of sharing it.

A failed push is not a failed run. The result is built; it is just not fetchable yet. Recording it as a failed run would throw away a correct result and invite it to be rerun, and would put the wrong thing in front of the person reading the run — the work is fine, the remote is the problem.

Null means no publication. A repository that never named a remote is never pushed from and never has to explain why it was not, so adding the column started nothing pushing on its own.

## Alternatives

Record the local HEAD after a successful push. It is the failure this decision exists to prevent: the push's own exit code and the local tracking ref both agree with the push, and neither has asked the remote anything.

Read the local remote-tracking ref instead of `ls-remote`. The push writes that ref, so it agrees by construction and verifies nothing.

Force the push when it is refused. A refusal means the remote holds something the push did not expect, and rewriting another team's history to publish a run is not a trade gate may make on its own.

Set an upstream, as a person pushing by hand would. It changes what `gate clean` considers disposable, so it turns publishing into a way to lose a worktree.

Fail the run when the push fails. It discards a finished result over a transport problem and hides the actual fault.

Default every repository to publishing to its origin. Work would start leaving machines because a column appeared, which is not a decision gate gets to make for a repository.

## How it works

`publishBranch` refuses at once when the repository has no publication remote. Otherwise it pushes the branch explicitly to the remote, then asks that remote what the ref points at. A read that fails, or a reply that is not a commit, returns `not-verified` with what the remote said. Only a verified read produces a publication, and it carries the commit the remote itself reports.

The push happens on the machine holding the worktree, because the server has no checkout of it. `gate publish` sends work mid-run as a checkpoint commit whose message says what it is; work still going is exactly the work worth asking about.

A publication failure is recorded against the run as `publish_error` and leaves the run's own outcome alone.

## Consequences

A publication costs a network round trip beyond the push, and a remote that is unreachable for reads reports `not-verified` even when the push itself worked. That is the intended bias: unverified is treated as unpublished rather than assumed good.

`ask` can only answer from verified commits, so a repository whose pushes are not verifiable is not askable, and the reason is named rather than silent.

Anything that records a publication without reading the remote back reverses this record and needs its own.

## Touches

- `src/repos/publish.ts`
- `src/client/release.ts`
- repos
- runs

## Supersedes

none
