Status: done
Branch: main
Decisions: docs/decisions/0019-model-scoped-rate-limits.md — the classification
rule, the block storage and the evidence order are new decisions; the account
pool's design doc described the intent ("a model-specific 429 is left alone")
but the code did not follow it, so the doc was already ahead of the behaviour
and is corrected to describe what now happens
Design: docs/design/account-pool.md (rotation before tier, availability, the
pool's quota and the card)

# A model's weekly limit blocks that model, not the account

## Goal

On the live gate, two of three connected accounts had spent their Fable week —
`seven_day_fable` at 99% and 100%, `five_hour` at 39% and 0% — and a request
for **Opus** was refused pool-wide, parked under `cooldown_until` for eight
hours by a `Retry-After` that was days away. `attemptOnAccount` read
`anthropic-ratelimit-unified-status: rejected` as "the whole account", which
Anthropic also sends when a model-scoped window is spent; the comment in
`sendWithFallback` said a model-specific 429 must be left alone, and the code
did the opposite.

What done looks like, from the task:

- A rejection caused by a model-scoped window blocks only the models in that
  scope on that account, until the window resets; the account keeps serving
  every other model.
- An account-wide rejection still cools down the whole account, as before.
- Distinguished by headers first (only if a header names the window — none
  does), then the snapshot (scoped window ≥99% with `five_hour`/`seven_day`
  below), then today's behaviour as the safe fallback.
- Selection, `poolQuota` and the pool's 429 work per model; the 429 names the
  real reason for each account and blames the throttle only when the throttle
  caused it.
- The block survives a restart.
- When every account is blocked for the requested model only, the tier
  fallback chain serves the request instead of a pool-wide 429.
- The throttle's own logic is untouched.

Out of scope: clearing the cooldowns already sitting in the live database
(emma until 20:00, john until 17:29) — a separate decision.

## Approach

Classify, then park. `classifyUnifiedRejection` in `account-pool.ts` (pure,
like the rest of that module) reads the reply headers for a per-window
`-status: rejected` naming an account-wide window — the only window names the
confirmed header set can carry — and otherwise reads the snapshot, whose
scoped weekly windows are the only place model-scoped limits exist. A block
is stored by **window name** (`seven_day_fable`), so whatever maps to that
window is blocked and nothing else is; the model→window map is the tier map
gate already serves (`pricing.tierOf` + fable/opus/sonnet → their
`seven_day_*` windows). Storage is one JSON column on `accounts`,
migrated in `db.ts` in the existing column-migration list; expiry is the
window's own reset (capped at eight days, fifteen minutes when no reset is
known), and nothing clears it early because a success on another model
proves nothing about the blocked window.

`sendWithFallback` tracks *how* accounts were spent: account-wide parking
stops the walk (a cheaper tier draws on the same exhausted logins);
model-scoped parking lets the walk continue to the tier chain, where the
cheaper model finds the same logins eligible again.

## Baseline

`tests/account-pool.test.ts` (37 passing) and `tests/fallback.test.ts`
covered the old behaviour: `rejected` → park, model-specific (no `rejected`
header) → same account, tier down. Those tests keep passing — an
unattributable rejection still parks the account, which is the safe side.

## What was built

1. `src/lib/account-pool.ts` — `TIER_WINDOWS`/`modelScopedWindow`,
   `ModelBlock`/`activeModelBlock(s)`/`upsertModelBlock`,
   `classifyUnifiedRejection`; `eligibleAccounts`, `selectAccount` and
   `poolQuota` take the model and count `modelBlocked`.
2. `src/lib/accounts.ts` — `modelBlocks` on the `Account` shape, parsed from
   the row; `setAccountModelBlock`; re-auth clears the blocks with the rest
   of the failure state.
3. `src/lib/db.ts` — the `accounts.model_blocks_json` column migration.
4. `src/lib/gateway-core.ts` — the classification in `attemptOnAccount`, the
   model-block branch in `sendWithFallback` (with the chain-continuation
   rule), model-aware selection in `dispatch`, and the pool-wide 429
   rewritten to state each account's real reason.
5. Surfaces — `/api/accounts` labels the blocks for the card; the accounts
   card shows "Fable limit blocked …" instead of a cooldown badge;
   `gate usage` counts model-parked accounts separately from cooling-down
   ones.
6. Versions — `cli.ts` changed, so plugin.json, marketplace.json and
   `GATE_VERSION` move to 0.40.1 together. The bundle itself is not rebuilt
   in this change: `plugins/gate/scripts/gate.mjs` carries another session's
   uncommitted work, and rebuilding it here would fold that in.

## Done when

- A Fable-scoped rejection leaves the account serving Opus (selection skips
  it for Fable only) — tests in both files.
- An account-wide rejection still cools the whole account down — the
  pre-existing tests, unchanged.
- With every account Fable-blocked, a Fable request lands on the tier chain,
  on the same logins, with no cooldown anywhere.
- An undecided rejection (no headers, no snapshot) parks the account, as
  before.
- The block is read back from the database on a fresh `listAccounts`.
- `npm test` and `npm run typecheck` pass.

## Follow-up — the account-wide paths that still read a model's window

The reactive path (a 429 classified into a `ModelBlock`) was not the only way
a model's week could park a login. Two account-wide readings still scanned
every window, so a spent `seven_day_fable` held the account back for every
model even with the block working:

- `quotaBlockedWindow` — the proactive floor. A scoped window at or under
  `quotaMinRemainingPercent` dropped the account from `eligibleAccounts` for
  every model, before any request was sent.
- `exhaustedWindowReset` — the cooldown length for an account-wide rejection.
  A scoped window at or above 99% timed the park off that window's reset,
  sitting the login out to the eight-hour cap instead of until the
  account-wide window recovered.

Both now skip model-scoped windows through one predicate,
`isModelScopedWindow`, which `scopedWindowName` also reads so the two
definitions cannot drift.

## Done when

- The floor holds an account back on `five_hour` / `seven_day` only; a
  login whose Fable week is spent still serves Sonnet.
- An account-wide cooldown is timed off an account-wide window; a quota with
  only a scoped window out reports no reset and falls back to the 5h one.
- Both are covered by tests that fail without the change.
- `npm test` and `npm run typecheck` pass.
