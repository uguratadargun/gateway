# 0056. Forges that spell a repository two ways are one name

Status: accepted
Date: 2026-09-29
Run: manual

## Context

GitHub's ssh over port 443 and Azure DevOps's ssh and https forms gave one repository two names, so what one clone recorded another could not find. Decision 0007 says an unknown name is never guessed.

## Decision

Only spellings the forge itself documents are mapped: `ssh.github.com` is `github.com`; `ssh.dev.azure.com:v3/…` and `dev.azure.com/…/_git/…` are `dev.azure.com/org/project/repo`. A query or a fragment is not part of the name. Bitbucket Server's `/scm/` form is not mapped.

## Rationale

A documented mapping is not a guess. `/scm/` cannot be recognised from the host, and mapping it could fold two repositories into one name.

## Alternatives

Map nothing. Memory stays split between clones.

A general rule from the shape of the URL. It risks merging repositories that are not the same.

## How it works

`parseRemote` in `src/repos/identity.ts` normalises the host and the path segments through the forge aliases before the name is built.

## Consequences

Identities stored earlier under the old spelling stay as they are; the Pitfalls in the repositories design doc say so.

## Touches

- `src/repos/identity.ts`
- `docs/design/repositories.md`
- repositories

## Supersedes

none
