# Account pool

## Summary

A person connects one or more Claude logins to gate, and every request is
served by one of them. With a single login gate is a proxy; with a second it
becomes a pool: an account that hits its rate limit is parked until its window
resets and the next one takes over, before any tier is downgraded. The
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
                                 429 (model-specific) ─▶ same account, cheaper tier
```

That order is the point. A cheaper model on an **exhausted account** is served
by the same exhausted quota, so rotating accounts has to come first; a
**model-specific** limit is the opposite — the account is healthy, and dropping
a tier is the cheap fix. Parking a healthy account for the second case would
take it out of the pool for everything else, so gate does not. The two are told
apart by the `anthropic-ratelimit-unified-status` header: `rejected` means the
whole account. A 401 that survives a token refresh parks the account for a
minute as dead. Only when every account is spent does the tier fallback chain
drop a rung, and if the accounts are all spent there is nothing a cheaper tier
can do, so the walk stops there.

**Rotation strategies** (Settings → the accounts card, `accountPool.strategy`):

| Strategy | Picks |
| --- | --- |
| `fill-first` (default) | The highest-priority account until its window runs out. One prompt cache stays hot. |
| `round-robin` | Sticks for `stickyRoundRobinLimit` requests (default 3), then rotates to the least-recently-used account. A retry after a failure never sticks. |
| `least-used` | Always the account idle longest. Never-used accounts go first, lower backoff first. |
| `p2c` | Two at random, the healthier of the two — health is 100 minus 10 per backoff level, 20 for a last error, 30 while cooling down, and the 5h utilization over ten. |
| `random` | Uniform among available accounts. |

Availability is not just "enabled": an account is skipped while it is cooling
down after a rate limit, and — if `quotaMinRemainingPercent` is set — while
any quota window has less than that percentage left. Cooldowns follow the
upstream: `Retry-After` wins, an exhausted quota waits for its window reset
(fifteen minutes when no reset is known, never more than eight hours), and
anything else backs off 5 s · 2ⁿ up to two minutes with a little jitter; a
5xx sits the account out for three seconds. An account past the throttle's
block ceiling is skipped rather than refused, because having a second login is
exactly what should keep the request alive. When no account at all can serve,
the 429 says so in the response: that it is gate's and not Anthropic's, how
many accounts it tried, and what the ceiling was.

Each account's windows come from the `anthropic-ratelimit-unified-*` headers
on every reply, so a busy account's bars stay current for free. The accounts
card draws **every** window the account reports — session, weekly, and
whatever per-model ones the plan carries — each with what is left and when it
rolls over, under the names Claude Code's own `/usage` uses for them. The
header spelling and the usage endpoint's differ for one of them: `7d_oi` is
`seven_day_overage_included`, *overage included* and not Opus. Gate folds the
two into one window, so an account cannot list the same limit twice. Those
headers only exist on a reply, though — a **just-connected account has no
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
  reloaded while reordering the pool, triggers nothing.
- **Periodic refresh is the daemon's job**, once per `quotaRefreshMinutes`
  (default 30 — slow on purpose against a 5h window).
- **Failures back off**: 10 min, doubling per consecutive failure, capped at
  4 h; a 429 additionally pauses that token for three minutes. One poll per
  account is in flight at a time, so the dashboard and the daemon firing
  together at boot do not earn the 429 between them. Chat is untouched either
  way, and the panel shows the reason instead of a blank bar.

Rate-limit state belongs to an account, not to gate. Each login carries its
own 5h / 7d snapshot on its row; the pre-pool global snapshot is still written
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

- `src/lib/accounts.ts` — the account rows: priority, last use, backoff level, cooldown, quota snapshot; tokens sealed in the row
- `src/lib/account-pool.ts` — pure selection and cooldown rules: eligibility, the five strategies, `computeCooldown`, unified-header parsing and window-name folding
- `src/lib/token-manager.ts` — proactive and forced refresh, one in-flight refresh per account
- `src/lib/seal.ts` — AES-256-GCM under a key derived from `GATE_SECRET`; `tryOpen` for a blob sealed under a different secret
- `src/lib/claude/oauth.ts`, `src/lib/claude/pkce.ts`, `src/lib/claude/config.ts` — the PKCE login, the public Claude Code client id, the endpoints and pinned CLI versions
- `src/lib/claude/identity.ts` — the request shape the `claude_code` scope requires
- `src/lib/claude/usage.ts` — the usage-endpoint poll, its backoff and its 429 pause
- `src/lib/gateway-core.ts` — `dispatch` picks the account and applies the throttle; `sendWithFallback` walks the pool before the tier chain; `captureQuota` writes each reply's headers back to the row
- `src/lib/ratelimit.ts` — the global snapshot and forecast, fed history only for a single-account pool

## Pitfalls

- The sealed tokens are unreadable under a different `GATE_SECRET`. Rotating the secret means logging every account in again; the rows survive, the credentials do not.
- A model-specific 429 does not park the account. If the whole pool keeps failing on Opus only, expect tier fallbacks, not rotation.
- `fill-first` with one hot account is the cache-friendly choice; `random` and `p2c` spread traffic and cold prompt caches with it.
- The quota floor (`quotaMinRemainingPercent`) reads *any* window, including a per-model weekly one; a floor of 10 can idle an account whose session window is empty of nothing.
- A freshly connected account shows no bars until it is polled or serves a request. That is not a failure; the daemon fills it within `quotaRefreshMinutes`.
- The usage endpoint's own 429 pauses polling for that token, not for chat. A bar that stops updating while requests still flow is this, and the panel says so.
- The rate-limit forecast is meaningless on a pool of more than one account and is deliberately not fed; per-account windows on the rows are the reading to trust.

## Decisions

- none recorded yet
