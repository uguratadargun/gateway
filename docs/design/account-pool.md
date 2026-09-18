# Account pool

## Summary

A person connects one or more Claude logins to gate, and every request is
served by one of them. With a single login gate is a proxy; with a second it
becomes a pool: an account that hits its rate limit is parked until its window
resets and the next one takes over, on the same model — and a limit scoped to
one model blocks that model on that account, leaving the login serving the
rest. The
dashboard shows every account's quota windows live, and each response says
which login served it.

## How it works

Login is the same Authorization-Code-with-PKCE flow Claude Code uses
(`claude.ai/oauth/authorize`, then a token from
`api.anthropic.com/v1/oauth/token`); the person approves in the browser and
pastes the code Anthropic shows them. Tokens are sealed AES-256-GCM under
`GATE_SECRET` and never leave the accounts module in plaintext — the account
shape the dashboard and the pool see carries none of them. Access tokens are
refreshed proactively when under five minutes remain, with one in-flight
refresh per account so concurrent callers never race a rotation, and
reactively on a 401. Each login keeps its own device id, so one machine's
accounts are not correlated upstream. Requests go out in the shape a genuine
Claude Code session sends — the identity headers and the `"You are Claude
Code…"` system sentinel the `claude_code` OAuth scope requires.

Every request picks an account first, and only then a model:

```
Claude Code ──▶ gate ──▶ pick account ──▶ pick tier ──▶ api.anthropic.com
                              │
                              └─ 429 (account-wide) ─▶ park it, next account, same model
                                 429 (model-scoped) ─▶ block that model on this account,
                                                      next account, same model
```

That order is the point. A cheaper model on an **exhausted account** is served
by the same exhausted quota, so rotating accounts has to come first. The
`anthropic-ratelimit-unified-status: rejected` header says only that *a* claim
was refused — Anthropic sets it when a model-scoped window such as
`seven_day_fable` is spent just as when the whole account is, and no reply
header has ever named a model-scoped window. So gate classifies the rejection,
in order of evidence: a per-window `-status` header naming an account-wide
window decides as the whole account; failing that, the account's snapshot
decides — a scoped weekly window at or above 99% while `five_hour` and
`seven_day` sit below it is the window that was rejected; and when neither
source decides, the whole account is the answer, because parking an account is
the safe side of undecided. A **model-scoped** rejection blocks that model on
that account until the window resets — the login keeps serving every other
model, and the next login takes the blocked one. A 401 that survives a token
refresh parks the account for a minute as dead. The tier fallback chain drops a
rung once every account is spent for the requested model, whether by cooldown
or by a model-scoped block: a cheaper model reads a different window, so a
model-scoped block is the one way the chain fires while logins remain. When the
accounts are spent on the account-wide windows instead, a cheaper tier would be
served by the same exhausted quota, and the walk stops there.

**Rotation strategies** (Settings → the accounts card, `accountPool.strategy`):

| Strategy | Picks |
| --- | --- |
| `fill-first` (default) | The highest-priority account until its window runs out. One prompt cache stays hot. |
| `round-robin` | Sticks for `stickyRoundRobinLimit` requests (default 3), then rotates to the least-recently-used account. A retry after a failure never sticks. |
| `least-used` | Always the account idle longest. Never-used accounts go first, lower backoff first. |
| `p2c` | Two at random, the healthier of the two — health is 100 minus 10 per backoff level, 20 for a last error, 30 while cooling down, and the 5h utilization over ten. |
| `random` | Uniform among available accounts. |

Availability is not just "enabled": an account is skipped while it is cooling
down after a rate limit, while the requested model is blocked on it by a
model-scoped window, and — if `quotaMinRemainingPercent` is set — while
an account-wide quota window has less than that percentage left. Cooldowns
follow the upstream: `Retry-After` wins, an exhausted quota waits for the
reset of the account-wide window that is out — a model's week never times a
cooldown on the login — (fifteen minutes when no reset is known, never more
than eight hours), and anything else backs off 5 s · 2ⁿ up to two minutes
with a little jitter; a
5xx sits the account out for three seconds. A model-scoped block runs until
its own window resets, which for a weekly window legitimately runs days out —
the block names the model, not the login, so the length costs nothing. An
account past the throttle's block ceiling is skipped rather than refused,
because having a second login is exactly what should keep the request alive.
When no account at all can serve, the 429 says so in the response: that it is
gate's and not Anthropic's, how many accounts it tried, and the real reason
for each one — cooling down until when, which model is blocked until when,
paused, or over the ceiling. The throttle is named only when it caused the
refusal.

Each account's windows come from the `anthropic-ratelimit-unified-*` headers
on every reply, so a busy account's bars stay current for free. The accounts
card draws every window the account reports — session, weekly, and whatever
per-model ones the plan carries — each with what is left and when it rolls
over, under the names Claude Code's own `/usage` uses for them, and re-reads
them every fifteen seconds so a card left open shows what the last reply
stamped. A model-scoped block is drawn as what it is — "Fable limit blocked,
in 3d" on a row that is otherwise serving — and never as the account cooling
down. Re-reading costs a database read and nothing upstream: the rules
below decide when Anthropic is actually asked.

One window is kept and never shown: `seven_day_overage_included` — the weekly
window with extra usage counted on top (`oi` is *overage included*, not Opus).
Anthropic sends it for some accounts and not others, so it appeared on one row
and was missing from the next with nothing to explain the difference, and when
it did appear it said roughly what the weekly limit beside it already said.
It is dropped in `accountWindows`, so every surface that reports windows
agrees, and it is never named as the reason an account was held back either —
counting extra usage on top means it never has less left than the weekly
window, which therefore reaches the quota floor first. The header spelling and
the usage endpoint's differ for it (`7d_oi` against the full name) and gate
still folds the two into one window, so nothing lists the same limit twice.

Those headers only exist on a reply, though — a **just-connected account has no
window reading at all** — so gate also reads Claude's own usage endpoint
(`/api/oauth/usage`, the one the CLI uses; no inference, no tokens spent).
That endpoint describes every limit twice, as legacy keys and as a `limits`
list; the model-scoped weekly limit exists only in the list, so both are read
and a window is never given twice.

Anthropic rate-limits that endpoint separately from `/v1/messages`, so gate
asks it as little as it can get away with:

- **A busy account is never polled.** Its replies already stamped the same
  snapshot, so it never looks stale.
- **The dashboard polls only an account that has never been polled at all** —
  enough to fill a new account's bar, and nothing more. A page left open, or
  reloaded while reordering the pool, triggers nothing; the card's fifteen
  second re-read goes no further than gate's own database.
- **Periodic refresh is the daemon's job**, once per `quotaRefreshMinutes`
  (default 30 — slow on purpose against a 5h window).
- **Failures back off**: 10 min, doubling per consecutive failure, capped at
  4 h; a 429 additionally pauses that token for three minutes. One poll per
  account is in flight at a time, so the dashboard and the daemon firing
  together at boot do not earn the 429 between them. Chat is untouched either
  way, and the panel shows the reason instead of a blank bar.

Rate-limit state belongs to an account, not to gate. Each login carries its
own 5h / 7d snapshot on its row, and its model-scoped blocks beside it —
`model_blocks_json`, so a block on a model outlives a restart the way a
cooldown does; the pre-pool global snapshot is still written
from every reply, but its history — the series the forecast is built from —
is only fed when the pool holds a single account, because two accounts
interleaved describe neither's window. Disconnecting the last account forgets
the shared history.

`x-gate-account` on the response names the login that served the request. The
same windows are what `gate usage` / `/gate:usage` reports to a machine on the
gateway — the plan usage Claude Code's own `/usage` cannot show once a session
authenticates with a gate key. Reading it does not poll: only an account that
has never been polled at all is filled in, the same rule the dashboard follows.

## Key files

- `src/lib/accounts.ts` — the account rows: priority, last use, backoff level, cooldown, model blocks, quota snapshot; tokens sealed in the row
- `src/lib/account-pool.ts` — pure selection and cooldown rules: eligibility, the five strategies, `computeCooldown`, unified-header parsing, window-name folding and `HIDDEN_WINDOWS`, the model→window map, and `classifyUnifiedRejection`, which decides whether a `rejected` status was the account's claim or one model's window
- `src/components/accounts-panel.tsx` — the card: the rows, their windows re-read on an interval, and the rotation form that interval must not overwrite
- `src/lib/token-manager.ts` — proactive and forced refresh, one in-flight refresh per account
- `src/lib/seal.ts` — AES-256-GCM under a key derived from `GATE_SECRET`; `tryOpen` for a blob sealed under a different secret
- `src/lib/claude/oauth.ts`, `src/lib/claude/pkce.ts`, `src/lib/claude/config.ts` — the PKCE login, the public Claude Code client id, the endpoints and pinned CLI versions
- `src/lib/claude/identity.ts` — the request shape the `claude_code` scope requires
- `src/lib/claude/usage.ts` — the usage-endpoint poll, its backoff and its 429 pause
- `src/lib/gateway-core.ts` — `dispatch` picks the account for the requested model and applies the quota ceiling; `sendWithFallback` walks the pool before the tier chain, parking account-wide rejections on the login and model-scoped ones on the pair; `captureQuota` writes each reply's headers back to the row
- `src/lib/ratelimit.ts` — the global snapshot and forecast, fed history only for a single-account pool

## Pitfalls

- The sealed tokens are unreadable under a different `GATE_SECRET`. Rotating the secret means logging every account in again; the rows survive, the credentials do not.
- A model-scoped 429 parks the model on the account, not the account in the
  pool: the login serves every other model while one weekly window is out, and
  if every login is blocked for the one asked, expect the tier chain, not
  rotation. The block expires on its own reset — a success on another model
  proves nothing about that window, so nothing clears it early. A rejection
  that neither headers nor the snapshot can attribute still parks the whole
  account; that is the safe side of undecided.
- `fill-first` with one hot account is the cache-friendly choice; `random` and `p2c` spread traffic and cold prompt caches with it.
- The quota floor (`quotaMinRemainingPercent`) reads the account-wide windows only. A per-model weekly one at the floor is what the model block is for, and holding the whole login back on it would idle an account whose session window is empty of nothing.
- A freshly connected account shows no bars until it is polled or serves a request. That is not a failure; the daemon fills it within `quotaRefreshMinutes`.
- The usage endpoint's own 429 pauses polling for that token, not for chat. A bar that stops updating while requests still flow is this, and the panel says so.
- The rate-limit forecast is meaningless on a pool of more than one account and is deliberately not fed; per-account windows on the rows are the reading to trust.

## Decisions

- none recorded yet
