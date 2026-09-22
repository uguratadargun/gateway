# 0033. The traffic log is kept by time, not by row count

Status: accepted
Date: 2026-09-22

## Context

The traffic log has always been bounded by a row count: `MAX_ROWS = 500`,
compiled into `src/lib/traffic.ts`, enforced on every insert by deleting
everything past the newest 500. Nobody chose 500 for a reason a person using
the product could recognise — it is not a disk budget, not a time span, not
tied to how busy a gate is. On a quiet personal gate it holds months; on a
busy one it holds two hours. The Traffic page compounds the problem on top of
the cap: it fetches the newest 100 rows once and re-fetches the same 100
every six seconds, so scrolling down ends the log at whatever the cap left
behind, and there was never a way to see anything older.

A sibling team, working the same file on an unmerged branch, considered this
question already and recorded two decisions in memory: `3115ea44-1-7fd8b045`
kept the bound as a row count (`traffic.maxRows`, default 5,000, made
editable but still counted in rows), and `3115ea44-2-29d6d379` made that knob
editable only by hand-editing the settings file on disk, not from the
dashboard. Neither branch is merged, and neither decision exists as a file in
this repository, but the person whose gate this is asked directly for the
opposite of both, so this record makes that instruction the recorded decision
rather than leaving it to be reconciled silently at merge time.

## Decision

The traffic log is bounded by age, not by row count. There is no
`MAX_ROWS` and no other ceiling on how many rows may exist at once. Instead,
`GateSettings` carries `traffic.retentionDays` — a whole number of days,
default 7, floored at 1 — and a row is deleted once it is older than that
many days. The window is a setting a person edits from the dashboard's
settings panel, on the home page, the same way every other operational knob
there is edited: its own card, its own Save, PUTting only the key it owns.

## Rationale

A row count answers a question nobody asks. "How many rows" has no intuitive
relationship to anything a person cares about when they open this page — they
want to know what happened yesterday, or this week, not whether the gate has
produced fewer than five thousand requests since the count last reset. "How
many days of traffic to keep" is the question the page is actually for, and
it is the one the cap at 500 answered with "no" by construction: on any gate
busier than a trickle, 500 rows is less than a day.

The disk argument for a row cap is real, and it is answered with numbers
rather than dismissed. A row is bounded because its two previews are each
truncated at 2,000 characters (`MAX_PREVIEW`), so a row is on the order of a
few kilobytes, worst case. Disk then grows as traffic × window, not without
bound: twenty thousand served requests in a day is roughly 80 MB of log, and
a week of that same rate is roughly 560 MB — orders of magnitude below what a
personal machine notices, and the number a busy team's gate would actually
reach is visible to the person who set the window, because they chose it in
days, not by working out what five thousand rows means for their own traffic.

The floor of 1 day, enforced in `mergeSettings` and again in the API schema,
exists so the setting cannot become an accidental "keep nothing": a
hand-edited `0` or a negative number in `~/.gate/settings.json` clamps up to
1 rather than reaching the pruner. There is deliberately no "keep forever" —
that is the unbounded case this record is explicitly not choosing — so the
absence of a ceiling stays reachable only through raising the number, never
through removing it.

## Alternatives

Keep the bound as a row count, made editable (`3115ea44-1-7fd8b045`:
`traffic.maxRows`, default 5,000, floored). Rejected because a row count
answers the wrong question. It scales with how busy the gate is rather than
with how far back a person wants to look, so the same number means two hours
of history on one gate and four months on another, and nobody setting it can
reason about which they are choosing without first knowing their own traffic
rate.

Edit the window only by hand-editing the settings file on disk, not from the
dashboard (`3115ea44-2-29d6d379`). Rejected because every other operational
knob on this gate — budgets, throttling, retries, compression, the account
pool's strategy — is a card on the home page with its own Save, and this
window is no different in kind. A knob reachable only by editing JSON on the
machine the gate runs on is unreachable from the one place a person actually
manages this product, and it would have kept the settings panel's card count
truthfully at six rather than seven, which is the tell that it was chosen to
avoid touching the panel rather than on its own merits.

Keep a row cap in addition to a time window, belt and suspenders. Rejected as
solving a problem the arithmetic above shows does not need two bounds: the
window already bounds disk, in terms a person can reason about, and a second
bound in a different unit reintroduces the original problem of a number
nobody can relate to their own traffic.

Prune on read, inside `readTraffic`, instead of on write. Rejected on
decision 0017's own rationale, reused rather than re-argued: `/traffic` polls
every six seconds, and a read path that triggers a write path on a timer is a
bad trade. Pruning stays where 0017 already put it — after the insert in
`recordTraffic` — with one addition: it also runs from the settings PUT route
when the patch touches the traffic section, so lowering the window takes
effect the moment it is saved rather than waiting for the next request to
write a row.

## How it works

`recordTraffic` prunes after every insert, as it did before this record, but
the statement changes from a subquery that sorts the whole table by `ts` to
find everything past row 500, to an indexed range delete —
`DELETE FROM traffic WHERE ts < ?` — against the same `ts` index the reads
already use. The cutoff is `now - retentionDays * 86_400_000`, with
`retentionDays` read from the person's saved settings at prune time, not
cached, so a window lowered a minute ago is honoured on the very next write.

`PUT /api/settings` prunes once more, only when the patch it just saved
touched the `traffic` section, so a person who lowers the window from the
panel sees it take effect on Save rather than on whatever request happens to
arrive next. No other settings write prunes traffic, and no read path does.

Removing the row cap turns "read the newest rows" into "read a page of rows,
and be able to ask for the next one," which needs a stable position to page
from. `ts` alone cannot serve as that position because it is a millisecond
epoch and is not unique across rows, so the position is the pair `(ts, id)` —
`id` being the table's own autoincrement, monotonic with insertion — read
back as an opaque cursor string the client hands back unexamined to ask for
the next older page. An idle gate that stops receiving requests keeps its
last rows past the window until the next request writes one, or a person
presses Clear — the same honest gap 0017 already accepted for its own
best-effort insert, now extended to pruning as well.

## Consequences

Disk is now the person's resource to bound, in a unit they can reason about,
rather than a number gate chose for them. It grows with traffic rather than
sitting at a fixed ceiling, so a very busy gate with a long window genuinely
uses more disk than it did under the row cap — that trade is the point of
this record, not an oversight in it.

An idle gate holds its last rows past the configured window until the next
request writes a new one or a person clears the log by hand; there is no
background sweep. This is a direct consequence of pruning on write rather
than on a timer, and it is written down here rather than left to be
discovered.

The CSV/JSON export at `/api/export?what=traffic` keeps its existing
`readTraffic(500)` bound, deliberately: it builds its entire response body in
memory as one string, and with no row cap the whole window could be hundreds
of megabytes. The export therefore means "the newest 500 rows" now, not "the
whole retained window" — a narrowing of what it silently used to mean, back
when 500 rows and the whole log were the same thing.

`id` is now part of every row `readTraffic` returns, appended last in the
object literal it builds. Because that literal's key order is the CSV
header of the export, `id` is a new trailing column in every export from
this point on; appending it is allowed by 0017's own consequences, reordering
is not.

A merge of the unmerged `gate/run-3115ea44` branch will conflict in
`src/lib/traffic.ts`, `src/lib/settings.ts`, `src/lib/schemas.ts`,
`src/app/api/traffic/route.ts`, `src/app/api/settings/route.ts`,
`src/app/traffic/page.tsx` and `src/components/settings-panel.tsx` — every
file this record touches. This record is the outcome that governs that
merge: the window stays in days, not rows, and it stays editable from the
dashboard, not only from the settings file on disk.

## Touches

- `src/lib/traffic.ts`
- `src/lib/settings.ts`
- `src/lib/schemas.ts`
- `src/app/api/traffic/route.ts`
- `src/app/api/settings/route.ts`
- `src/app/api/export/route.ts`
- `src/app/traffic/page.tsx`
- `src/components/settings-panel.tsx`
- dashboard
- gateway-pipeline

## Supersedes

none — the 500-row cap was a compiled-in constant, never a recorded decision
here; 0017 keeps its decision, and only a premise in its rationale ("at most
500 rows exist") stops being true.
