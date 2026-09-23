# 0007. A repository is named by its remote, and unknown is never guessed

Status: superseded by 0037
Date: 2026-09-16
Run: faf3bfe (the identity) / 7abbb8c (the chain it travels)

## Context

A path is not an identity. `/Users/ugur/work/api` on a laptop and `/home/ci/build/api` on a runner are the same repository; `~/desktop/api` and `~/server/api` are not, and both slug to `api`. Until this, gate had only those paths and that slug.

Memory is what made it matter. `memory_touches.ref` was a global key with nothing beside it, so `src/index.ts` in the desktop app and `src/index.ts` on the server were one row in every path lookup. A planner asking about a file it was standing in front of got another team's constraint back, and nothing in the answer said which repository it came from. The same gap let a decision in one of a team's repositories silently close a row belonging to another.

## Decision

A repository's identity is its git remote, normalised to `host/owner/name`. Where the remote does not say — a local path, a `file://` URL, a remote with no owner, a host without a dot — the identity is null, and null means unknown. It is never filled in from the path or from the slug. An identity that is already set is never moved: a repository whose origin comes to name a different one is reported as two identities that disagree, and a person decides.

## Rationale

Two repositories answering to one name is the single failure this identity must not have. It merges their memory, and nothing downstream reports it — a planner reads a constraint from a codebase it has never seen and has no way to tell.

Transport, credentials, port, a trailing `.git` and letter case are all ways of writing the same remote, so they normalise away. A nested GitLab group stays whole, because `ulak/mobile/ios` and `ulak/ios` are different projects.

A host without a dot is refused deliberately, and it is the case that looks most like an oversight. `git@github-work:ulak/api.git` is an ssh_config alias: it resolves to whatever one machine's config says, so two laptops can point one alias at two different servers. It is precisely the shape that would merge two repositories under one name, so it returns null.

Unknown is a true answer and a guess is not. Everything recorded before identity existed is unknown, and an offline checkout that has lost its remote is still the same repository — losing a remote does not revoke an identity.

The read side follows from the same rule. A caller that knows its repository hides decisions belonging to a *different* named one and keeps the unnamed ones, because unknown is not evidence of difference. A caller that does not know its own repository filters nothing, because it is in no position to rule anything out.

## Alternatives

The directory slug, which gate already had. Two checkouts of different projects with the same directory name collide, and the collision is invisible: both are `api`, both write to the same key.

The absolute path. Correct only on one machine. The same repository on a laptop and a runner would be two, and a repository moved on disk would lose its record.

Guess from the path when the remote does not say — take the last segment, or the parent directory. This produces the exact failure the decision exists to prevent, and produces it silently. A wrong name is worse than no name, because a wrong name is acted on.

Let the client name the repository. A client of an older version would name it differently from a newer one, and the same repository would accumulate two identities. Clients send the raw origin; the server does the naming, so a client of any age names a repository the same way.

Move the identity when the remote changes. Everything already written under the old name — decisions, touches, objections — would quietly come to mean something else. The two identities are reported instead.

## How it works

`canonicalRepoId` parses a remote in either of the two forms git accepts, lowercases host, owner and name, drops the port, credentials, a trailing `.git`, and returns `host/owner/name`, or null. Null propagates: a repository registered by path stays unknown until a remote is read off its checkout.

The identity travels the whole chain a path travels — the run that did the work, the decision it produced, each touch that decision left, and each objection raised out of it — so a lookup by path is answered within one repository. `supersedableBy` carries the same check, so a decision may only close a row from the repository it is about.

Setting a remote on a repository that already has an identity compares the two. Equal, or the new one null, and the record stands. Different, and the write is refused with both identities named, for the caller to resolve.

Repositories registered before this are backfilled at startup by asking each checkout what its own origin is. One that cannot answer stays unknown, which for it is the true answer.

## Consequences

Memory written before identity existed is unknown, permanently: it is kept and never hidden, so an old decision reaches every caller. A team that wants it scoped has to re-record it.

A repository whose remote legitimately moves — a rename, a host migration — needs a person. That is the intended cost; the alternative is a silent merge.

Anything that comes to identify a repository some other way reverses this record and needs one of its own. The rule is that the remote is the only source, and unknown is a value rather than a gap to be filled.

## Touches

- `src/repos/identity.ts`
- `src/repos/store.ts`
- `src/memory/store.ts`
- repos
- memory

## Supersedes

none
