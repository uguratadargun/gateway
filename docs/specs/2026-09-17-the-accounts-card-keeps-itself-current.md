Status: done
Branch: main
Decisions: none — no recorded decision covers which windows are drawn, and the
polling rule below is the one `docs/design/account-pool.md` already states
Design: docs/design/account-pool.md (windows, the polling rules, key files)

# The accounts card drops a window nobody can act on, and stops going stale

## Goal

Two complaints about the same card, from watching it during real use.

**A bar that appeared on some rows and not others.** `seven_day_overage_included`
— the weekly window with extra usage counted on top — was drawn as "weekly
limit incl. extra usage". Anthropic reports it for some accounts and not
others, so two rows on the same screen disagreed with no way to tell why, and
where it did appear it sat beside a "weekly limit" bar saying nearly the same
thing. There is no action behind the difference: same week, same plan.

**Usage that only moved on reload.** `AccountsPanel` fetched once on mount and
never again. Every reply gate serves stamps a fresh window reading onto the
account that served it, so the numbers move continuously while a run is going
— and the card showed whatever they were when the tab was opened.

Out of scope: how often gate asks Anthropic (unchanged, and deliberately
slow), a freshness stamp on each row, and the throttle's own reading.

## Approach

The window is dropped in `accountWindows`, not at each screen, so the accounts
card, `poolQuota` and `gate usage` cannot disagree about what exists. Hidden
means hidden everywhere: `quotaBlockedWindow` skips it too, rather than
leaving one path able to name a window no bar explains. That costs nothing,
because a window counting extra usage on top of the weekly one never has less
left than the weekly one, so the weekly one reaches the quota floor first. The
snapshot still stores it — this is a display rule, and un-hiding it is one line.

The card polls itself rather than the server pushing: it is one local database
read, `/api/accounts` already refuses to poll Anthropic for an account that
has been polled before, and the recorded rule that periodic upstream refresh
is the daemon's job stays exactly as it was. Fifteen seconds is short enough
to look live during a run and long enough to be free.

The poll is a second loader that sets the account rows and nothing else. The
full `refresh()` also resets the rotation form's saved baseline, and running
that under somebody mid-edit would answer their typing with the stored value
and lose the edit.

## Assumptions

- An idle account's reading still only moves when the daemon next polls it
  (`quotaRefreshMinutes`, default 30). The card says so rather than implying
  every number on it is fifteen seconds old.
- An account that reports the overage-included window and no plain weekly one
  does not occur — both arrive from the same header set and the same payload.
  If it ever did, that account would show one bar fewer.

## Baseline

`npx vitest run tests/account-pool.test.ts` — 37 passing. Full suite and
typecheck green.

## Documentation

`docs/design/account-pool.md`: the windows paragraph split in two, the hidden
window and the card's interval written down, the dashboard polling rule
extended to say the interval goes no further than gate's own database, and two
key files named. One changelog line under Unreleased.

## What was built

1. `src/lib/account-pool.ts` — `HIDDEN_WINDOWS`, skipped in `accountWindows`
   and in `quotaBlockedWindow`; the label entry removed.
2. `src/components/accounts-panel.tsx` — `ACCOUNTS_REFRESH_MS`, the quiet
   `poll()` beside `refresh()`, and the card saying what it re-reads and when.
3. `tests/account-pool.test.ts` — the window absent under either spelling from
   both `accountWindows` and `poolQuota`, and an account at 5% left on it not
   held back by the floor. The two alias-folding tests now use `7d`, which is
   the same rule on a window that is still shown.

## Done when

- No surface names the overage-included window, whichever spelling it arrived
  under, and no account is held back on it.
- A card left open follows usage during a run without a reload.
- An unsaved rotation edit survives the interval.
- The suite and the typecheck are green.
