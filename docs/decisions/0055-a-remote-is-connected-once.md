# 0055. A remote is connected once

Status: accepted
Date: 2026-09-29
Run: manual

## Context

The same remote could be connected twice, under two ids and two teams. Its owner, its publication remote and its memory are all found by the repository's name, and with two records the row order decided which one answered. A team could be refused its own repository, and a run could be told to publish to the other record's remote.

## Decision

Connecting a repository whose identity is already connected is refused, naming the record that holds it. Duplicates that already exist answer in a fixed order, oldest first, and a question to another team prefers the record inside the asker's family.

## Rationale

The identity is the key to everything about a repository. Two records under one key make every lookup a coin toss.

## Alternatives

A unique index on `repo_id`. Duplicates that already exist would break the migration.

One record per team. Ownership is one field and cannot be split.

## How it works

A URL is checked with `canonicalRepoId(source)` before it is cloned; a path is checked after its origin is read. The refusal is a 409. `repoByIdentity` orders by `created_at, id`, and the ask resolution picks the in-family record first.

## Consequences

If two teams want the same repository, one owns it and the other reads it through the family, or it stays unowned. Duplicates from before stay as they are until someone forgets one.

## Touches

- `src/app/api/repos/route.ts`
- `src/repos/store.ts`
- `src/orchestration/ask.ts`
- `docs/design/repositories.md`
- repositories

## Supersedes

none
