# 0019. A model's weekly limit blocks that model, not the account

Status: accepted
Date: 2026-09-18

## Context

Anthropic's weekly limits come in two shapes: the account-wide `seven_day`,
and model-scoped windows — `seven_day_fable`, `seven_day_opus`,
`seven_day_sonnet` — that each bound one model family on one login. Both are
announced the same way: `anthropic-ratelimit-unified-status: rejected` on a
429. The header does not say which claim was refused, and no reply header has
ever named a model-scoped window; the per-model windows exist only in the
usage endpoint's answer, which is why the account snapshot carries them and
the reply headers do not.

gate read `rejected` as the whole account. The live gate showed what that
costs on 2026-09-18: two of three connected accounts had spent their Fable
week — `seven_day_fable` at 99% and 100%, `five_hour` at 39% and 0% — and a
request for **Opus** was refused pool-wide. The rejection parked each account
under `computeCooldown`, which took the `Retry-After` (days away; the window
resets on the 21st), capped it at eight hours, and set `cooldown_until` — so
`eligibleAccounts` dropped both logins for every model. A healthy session
window on a healthy login served nobody. The comment in `sendWithFallback`
already said a model-specific 429 must be left alone, and the code did the
opposite of what the comment said.

## Decision

A `rejected` status is classified before anything is parked, on two sources
read in order.

1. **Upstream headers.** A per-window `-status` header naming an
   account-wide window decides as the whole account. No header names a
   model-scoped window, so nothing else is read from them — a header spelling
   is not guessed at.
2. **The account's quota snapshot.** A scoped weekly window at or above 99%
   (its reset not passed) while `five_hour` and `seven_day` sit below 99% is
   the window that was rejected. When the model asked for names its own
   exhausted scoped window, that one; otherwise a single exhausted scoped
   window; two or more that the model does not name is not decidable.

When neither source decides, the whole account is parked, as before:
undecided resolves to the safe side.

A model-scoped rejection records a **model block** — the window, the scope
the usage endpoint named it as, and the window's reset time — on the account
row (`accounts.model_blocks_json`, one JSON column), so it survives a
restart. Selection learns the model it is selecting for: `selectAccount`,
`eligibleAccounts` and `poolQuota` skip an account for model X only when X's
window is blocked on it, the model→window mapping being the one the tiers
already define (fable ↔ `seven_day_fable`, opus ↔ `seven_day_opus`, sonnet ↔
`seven_day_sonnet`; haiku has no scoped weekly window). A block expires on
its own `until` — a success on another model proves nothing about that
window, so nothing clears it early; re-authorizing the login clears it with
the rest of the failure state.

## Rationale

The account-wide cooldown is a correct response to the wrong question. A
weekly window is a property of a model family on a login; answering it with
`cooldown_until` — the one mechanism that takes a whole login out of the pool
— converts "Fable is out until Friday" into "everything is out for eight
hours", and with a two-account pool that is the whole pool. The failure was
invisible in the code review sense: every step did what it says (`rejected`
→ park), and the comment above it even named the case. The fix is to make the
classifier, not the status header, the decider, because only the classifier
has both sources of evidence.

The evidence order is the task's, and the right one: a header is a statement
about this reply; the snapshot is a measurement that may be minutes stale.
But the header cannot name a scoped window, so in practice the snapshot
decides — and it is a measurement gate already trusts for the quota floor
and the throttle, taken from the endpoint that owns these windows.

Blocking by *window name* rather than by model id means the block covers
whatever models draw from that window — today one tier each, tomorrow
whatever else maps there — and a block recorded for a scope the tier map
does not know (an unexpected model name in the scope) still blocks the model
that earned it without blocking anything else.

The eight-hour cap stays off this path deliberately. It guards against a bad
or hostile reset hint on a *cooldown*, where an over-long park hides an
account; a model block at the window's reset is not hiding anything — the
other models of that login serve throughout, and the blocked one is genuinely
out until Friday.

## Alternatives

Read the 429 response body for the refused claim's name. Nothing in the
captured fixtures carries it, the 429 body shape is not part of any
documented surface here, and code against an unobserved body is a guess with
a compile step.

Treat `rejected` as account-wide unless a scoped window is at exactly 100%.
The live readings were 99% and 100% on the same day for the same condition,
so an exact-equality threshold would have caught one account and missed the
other; 99% is the same threshold `exhaustedWindowReset` already uses for
"effectively exhausted".

Park the model on the account with the existing `cooldown_until` plus a
marker. One column fewer, but the two states would share a field that means
"the whole login is out" to every reader — the dashboard, the throttle, the
429 text — and each would have to remember to special-case the marker. The
separate list is what lets every surface read `cooldown_until` the way it
always did.

Drop the tier chain after a model-scoped pool exhaustion and return the 429.
When every login's Fable is out, a cheaper model genuinely has window left,
so walking the chain serves the request instead of refusing it; refusing was
the bug's second half.

## How it works

`classifyUnifiedRejection` in `account-pool.ts` (pure) takes the reply
headers, the account snapshot and the requested model, and returns either
`{kind: "account"}` or `{kind: "model", window, scope, until}`.
`attemptOnAccount` calls it once per rejected attempt, after `captureQuota`
has folded the reply's own window readings into the snapshot, and reports
`accountLimited` only for the account-wide kind. `sendWithFallback` parks an
account-wide rejection with `coolDownAccount` as before; a model-scoped one
writes the block with `setAccountModelBlock`, mirrors it onto the in-memory
row so the next selection in the same request sees it, and picks the next
account *for the same model*. When every account is spent **and at least one
was spent account-wide**, the walk stops — a cheaper tier would draw on the
same exhausted logins. When they were spent by model blocks alone, the tier
chain drops a rung, where the next tier's model finds the same logins
eligible again.

`until` is the snapshot window's reset, capped at eight days (a weekly window
is the longest legitimate reset there is); a block with no known reset runs
fifteen minutes, the same fallback `computeCooldown` uses, and re-derives on
the next rejection.

The pool-wide 429 now states the real reason for each account — `emma:
cooling down until 20:00; john: Fable limit blocked until 14:00; kai:
paused` — and names the throttle ceiling only when the ceiling caused the
refusal. The accounts card, `poolQuota` and `gate usage` show a model block
as a block on that model (`modelBlocked` count, "Fable limit blocked" badge),
never as the account cooling down.

## Consequences

An account blocked for Fable still serves Opus, Sonnet and Haiku throughout
its blocked week; the dashboard shows it as serving, with the block named on
the model. The eight-hour park that took two healthy logins out of the pool
is gone.

An undecided rejection keeps today's behaviour, so a genuinely account-wide
rejection with a stale or missing snapshot parks the whole account — one
request's worth of extra caution, corrected by the snapshot's next refresh.

A model block can outlive the condition it recorded if the usage endpoint
stops reporting that window (a plan change, say); it expires at the reset
time regardless, and re-authorizing the login clears it. The worst case is a
model refused on one login for at most the remainder of a weekly window while
other logins — and the tier chain — serve it.

The pool's 429 enumerates every connected account, so its message grows with
the pool. A personal gate's pool is a handful of rows; a per-account reason
is the answer to the question the person reading it has.

## Touches

- `src/lib/account-pool.ts`
- `src/lib/accounts.ts`
- `src/lib/db.ts`
- `src/lib/gateway-core.ts`
- `src/app/api/accounts/route.ts`
- `src/components/accounts-panel.tsx`
- `src/app/api/v1/usage/route.ts` (shape only, via `poolQuota`)
- `src/client/api.ts`, `src/client/cli.ts`
- `plugins/gate/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/lib/protocol.ts` (0.40.1)
- account-pool

## Supersedes

none — no recorded decision covered the `rejected` → park rule; it lived in
`docs/design/account-pool.md`, which this decision corrects, and in the
`sendWithFallback` comment, which the code now matches.
