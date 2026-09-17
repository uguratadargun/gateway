# 0017. The traffic log names who called and who served

Status: accepted
Date: 2026-09-17

## Context

A gate serves a small group of people through one endpoint, and each of them
holds a key that names them and their team. The traffic log knew none of that.
It recorded when a request arrived, which endpoint it came through, the name
the caller asked for, the model it resolved to, the status, and the two
truncated bodies — everything about the exchange and nothing about the two
parties to it.

The caller was thrown away at the door. `gatePrincipal` resolves the bearer
token to a key, a person and a team before the body is even parsed; `gateAuthOk`
wrapped it, kept the boolean, and dropped the rest. Nothing downstream could
have named a caller because nothing downstream was given one.

The account was half recorded. `traffic.account_id` was written on every row
and read back, but it is a uuid, and the page's own type omitted the field — so
the one piece of attribution that existed was invisible by construction.

Two questions therefore had no answer anywhere in the product: who made these
requests, and whose quota did they spend.

## Decision

A served request records who called and who served, as ids, and `/traffic`
resolves those ids to names as it reads them.

The principal rides on the dispatch options — key, person, team, scopes — set
by each of the three gateway endpoints and by the in-process workflow entry.
The traffic row gains `key_id`, `user_id`, `team_id` and `provider_id` beside
the `account_id` it already had. Reading is one `LEFT JOIN` across accounts,
providers, users, keys and teams; a row whose person or account has since been
deleted degrades to the next honest label rather than to blank.

## Rationale

The principal has to be plain data, not the request. A streamed reply is
accounted for from `after()`, after the response has been handed to the client
and the `Request` is gone; anything that needed to read a header at that point
would work for the non-streaming path and silently record nobody for the
streaming one — which is every Claude Code session. Four scalars captured at
dispatch time are carried by the closure that already exists, so the streaming
case needs no code of its own.

Ids at write time, names at read time, because both of the things being named
are mutable and deletable. An account's label is editable and defaults to its
email; a person can be renamed. Denormalising the label into the row would
freeze it at the moment of the call, so renaming an account would leave the log
speaking about a name that no longer exists anywhere in the product. The join
is cheap in the only place it runs: at most 500 rows exist, at most 100 are
read, and a deleted row yields NULL by construction — the degradation is the
schema's, not a branch someone has to remember to write.

The join also avoids a side effect. `listAccounts()` calls
`importLegacyAccount()` on every invocation; `/traffic` polls every six
seconds, and a read path that triggers a write path on a timer is a bad trade
for saving one SQL statement.

`provider_id` joins the row because the column would otherwise be meaningless
half the time. Exactly one of the account and the provider is set — a Claude
model has an account and no provider, a `local:` model the reverse — so
carrying both is what makes "who served this" a question with an answer for
every row.

A workflow node names itself rather than passing nothing. It is gate calling
its own pipeline in-process, and a null there would be indistinguishable from a
row written before this release.

## Alternatives

Denormalise the labels at write time. The row survives a deletion intact, which
is its real advantage, and it needs no join. Rejected because it freezes a
renamed account and a renamed person: the log would keep asserting a label the
product no longer has, and there would be no way to tell a stale label from a
current one.

Pass the `Request` down to the accounting. Impossible for the streamed path,
which is the majority path, and it would put a whole request object in a
closure that outlives the response.

Look the labels up in memory with `listAccounts()`, `listUsers()` and
`listKeys()`. Five round trips per poll instead of one, whole rows mapped and
hash-stripped to read one name, and `listAccounts()`'s legacy import fired on
a timer.

Record the caller's name on the row and skip the key id. It reads the same
until the person is deleted, at which point the row says nothing; keeping the
key id means a deleted person still leaves the key that made the call.

Fill in the gaps at the same time — a row for every cache hit and every
refusal, so callers could be counted. Rejected here, not on the merits: it
changes what the table *means*, from the upstream exchanges with their bodies
to every call, some with no body. That deserves its own record rather than
arriving inside a display feature.

## How it works

`gatePrincipal` is called instead of `gateAuthOk` by `/v1/messages`,
`/v1/chat/completions` and `/v1/responses`; the principal goes into
`DispatchOptions.caller` and the 401 is unchanged. `GateModelProvider` passes
the `workflow` sentinel. `finalize` reads `opts.caller` and writes the three
ids next to `accountId` and `providerId`, both of which it already had in
scope.

Two sentinels stand for the callers that hold no issued key: `local` for a gate
with no key issued and none configured, and `workflow` for the in-process
entry. Neither can collide with a real key id, which is sixteen hex characters.

`readTraffic` resolves two labels. The caller is the person's name, else their
email, else the key's name, else the sentinel spelled out, else `key <id>` for
a key that went with its owner, else `unknown` for a row written before this
release. What served is the account's label, else `removed account <prefix>`,
else the provider's label, else `removed provider <prefix>`.

The Traffic page reads person → model → account across the collapsed row, both
truncated with the full value on hover. The endpoint badge moves into the
expanded detail, which also carries the team, the key, the requested name and
the full ids.

## Consequences

The traffic log and its CSV export now carry people's names and email
addresses. Both sit behind the admin cookie, so the boundary has not moved, but
the content class is new: this is no longer only machine-shaped debugging
output.

A gate with no keys issued reads `local` on every row. That is honest — there
is no person to name — but it means the feature only pays off once `/team` has
been used.

The log still under-counts callers, and now visibly: a cache hit, any refusal,
and the proxied `/v1/models`, `count_tokens` and `batches/*` write no row. A
question about who is burning quota is exactly a question about 429s, and 429s
are among the missing. Answering it properly is the next record, not this one.

Attribution is best-effort by construction. The insert swallows its errors so
that a log line can never fail a served request, which also means a row that
was not written is silent.

`caller` is optional on `DispatchOptions`, so something added later that calls
`dispatch` will compile while recording nobody. The gate-provider test is the
canary for the one in-process caller that exists.

The key order of `readTraffic`'s returned object is the CSV header of
`/api/export?what=traffic`. New fields are appended; reordering them rewrites
the export's columns for everyone downstream.

## Touches

- `src/lib/gate-auth.ts`
- `src/lib/gateway-core.ts`
- `src/lib/traffic.ts`
- `src/lib/db.ts`
- `src/app/api/gateway/v1/**`
- `src/providers/gate-provider.ts`
- `src/app/traffic/page.tsx`
- gateway-pipeline

## Supersedes

none
