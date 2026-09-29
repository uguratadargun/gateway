# 0062. `--as-of` a date means the end of that day

Status: accepted
Date: 2026-09-29
Run: manual

## Context

A bare date parsed as UTC midnight. In Istanbul that is three in the morning, so "what held on 2026-05-01" left out decisions recorded that afternoon, and `--since` a date started three hours into the day.

## Decision

A bare `YYYY-MM-DD` is a day in the local time where the command runs. `--since` starts at the beginning of that day and `--as-of` asks about its end.

## Rationale

People mean the whole day when they name one.

## Alternatives

Keep UTC midnight. It is wrong by the local offset and still leaves out the rest of the day for `--as-of`.

Require timestamps. Nobody types them.

## How it works

`parseSince` reads a bare date as local midnight. `parseAsOf` returns the last millisecond of that day and reads anything else as `parseSince` does. `gate memory search --as-of` uses `parseAsOf`.

## Consequences

The same date names slightly different moments on machines in different time zones.

## Touches

- `src/memory/since.ts`
- `src/client/cli.ts`
- `docs/design/memory.md`
- memory

## Supersedes

none
