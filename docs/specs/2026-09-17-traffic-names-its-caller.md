Status: done
Branch: main
Decisions: docs/decisions/0017-the-traffic-log-names-who-called-and-who-served.md
Design: docs/design/gateway-pipeline.md ("Auth", "Accounting"), docs/design/dashboard.md ("What it must never show")

# The traffic log names the person who called and the account that served

## Goal

The Traffic page said when a request arrived, through which endpoint, to which
model, and with what status. It did not say who made it or whose quota it
spent — the two questions a gate serving several people is actually asked.

The caller was resolved and discarded: `gatePrincipal` turns a bearer token
into a key, a person and a team before the body is parsed, and `gateAuthOk`
kept only the boolean. The account was half recorded: `traffic.account_id` was
written and read back, but it is a uuid and the page's own type omitted it, so
the one attribution that existed was invisible.

Asked for: person, model, account, in that order, on the row.

Out of scope, deliberately: making callers *countable*. A response-cache hit, a
refusal (400, 401, 402, 429, 503) and the proxied `/v1/models`, `count_tokens`
and `batches/*` write no traffic row at all. Filling those in changes what the
table means, from served exchanges with their bodies to every call — its own
change, with its own record.

## Approach

The principal rides on `DispatchOptions` as four scalars rather than the
request itself. A streamed reply is accounted for from `after()`, after the
`Request` is gone, so anything that had to read a header at that point would
record nobody for every Claude Code session. `finalize` is already a closure
over the options, so the streaming path needed no code of its own.

Ids go in the row, names come out of the read. Both things being named are
mutable and deletable: an account label is editable and a person can be
renamed, so a denormalised label would freeze at the moment of the call.
`readTraffic` became one `LEFT JOIN` over accounts, providers, users, keys and
teams — a deleted row yields NULL by construction, which is the degradation
rule rather than a branch to remember. The join also keeps `listAccounts()` off
a six-second poll, since it fires `importLegacyAccount()` on every call.

`provider_id` joins the row because exactly one of account and provider is ever
set; carrying both is what makes "who served this" answerable for every row.

Two sentinels stand for callers holding no issued key — `local` and `workflow`
— neither of which can collide with a key id (sixteen hex characters).

## Assumptions

- "Which user" means the holder of the gate key. It is the only notion of a
  caller the gateway has, and `/team` is where it comes from.
- A row whose person or account is gone should still read. `removed account
  <prefix>` and the key's name are more useful than blank.
- `apikeys.last_host` does not belong in a per-request detail: it is where the
  key was *last* seen, not where this call came from.

## Baseline

`npm test` — 705 passing, 1 skipped, green. `npm run typecheck` clean.

## Documentation

`docs/decisions/0017`, all eight sections. `docs/design/gateway-pipeline.md`:
Auth says the principal is carried rather than reduced at the door, Accounting
says what the traffic row names and how the ids resolve, and two pitfalls —
the under-count and the best-effort insert. `docs/design/dashboard.md` notes
that the traffic log and its export are where this surface carries people's
names and emails. One changelog line under Unreleased.

## What was built

1. `src/lib/gate-auth.ts` — `LOCAL_KEY_ID` and `INTERNAL_KEY_ID` exported;
   the hard-coded `"local"` now uses the constant.
2. `src/lib/db.ts` — four column migrations: `traffic.key_id`, `user_id`,
   `team_id`, `provider_id`.
3. `src/lib/gateway-core.ts` — `DispatchOptions.caller`, and the three ids plus
   `providerId` on the `recordTraffic` call inside `finalize`.
4. `src/app/api/gateway/v1/{messages,chat/completions,responses}/route.ts` —
   `gatePrincipal` instead of `gateAuthOk`, the principal passed down; the 401
   is unchanged.
5. `src/providers/gate-provider.ts` — the in-process caller names itself.
6. `src/lib/traffic.ts` — `TrafficEntry` (write) split from `TrafficRow`
   (read), the join, `callerLabel` and `servedByLabel`.
7. `src/app/traffic/page.tsx` — person → model → account on the row, both
   truncated with the full value on hover; the endpoint badge and a detail grid
   (team, key, requested name, full ids) in the expansion.
8. `tests/storage.test.ts` — the names resolve, and the row still reads after
   the account and the person are deleted; the sentinels and `unknown`.
   `tests/traffic-attribution.test.ts` — the principal contract the three
   routes rely on. `tests/traffic-e2e.test.ts` — a request through
   `executeMessages` against a mocked upstream leaves a row naming the person
   and the account. `tests/gate-provider.test.ts` — the in-process caller.

## Done when

- A row names the person, the model and the Claude account, by name.
- A provider-served request names the provider instead of leaving the column
  empty.
- Deleting the account or the person leaves the row readable.
- A streamed request is attributed the same as a non-streamed one.
- The suite and the typecheck are green.
