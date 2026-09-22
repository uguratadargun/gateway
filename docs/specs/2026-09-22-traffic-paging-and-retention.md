Status: done
Branch: gate/run-112dc9b9
Decisions: docs/decisions/0033-the-traffic-log-is-kept-by-time-not-by-row-count.md
Design: docs/design/dashboard.md, docs/design/gateway-pipeline.md

# Traffic paging, and a retention window instead of a row cap

## Goal

Two things a person cannot do today on `/traffic`:

1. **See anything older than the newest 100 rows.** The page fetches
   `/api/traffic` once, gets `readTraffic(100)`, and re-fetches the same newest
   100 every 6 seconds, replacing the list each time. Scrolling down ends the
   log. After this change, reaching the end of the list loads the next page by
   itself, and the 6-second poll merges new rows at the top while every page
   already loaded stays put and the reader's scroll position does not move
   under them.
2. **Decide how much log to keep.** `MAX_ROWS = 500` in `src/lib/traffic.ts` is
   compiled in, and every insert deletes everything past row 500. After this
   change there is no row-count limit at all: the log is bounded by *age*, the
   window is a setting (default 7 days) in `GateSettings`, and it is edited from
   the dashboard's settings panel like every other setting there.

Out of scope, deliberately: the live SSE feed at the top of the page
(`LiveActivity`) — a different data source, a client-held buffer, not the log,
and paging is not wired into it (memory `3115ea44-3-f9225670`); filtering,
facets, tabs, request ids or any of the larger rebuild of this page that exists
unmerged on `gate/run-3115ea44`; and the shape of the CSV export, which keeps
its columns and gains one appended field.

## Approach

### Seams

- `src/lib/traffic.ts` owns the log: what a row is, how a page of rows is read,
  and when old rows go. It gains one read parameter (a cursor) and one
  exported function (`pruneTraffic`), and loses `MAX_ROWS`.
- `src/lib/settings.ts` + `src/lib/schemas.ts` own the window as a number of
  days, with the same merge-and-clamp shape every other section has.
- `src/app/api/traffic/route.ts` owns the wire form of a page: `limit`,
  `before`, and an opaque `nextCursor` the client hands back.
- `src/app/traffic/page.tsx` owns the list: the observer that asks for the next
  page, the merge that keeps what is loaded, and the scroll correction that
  keeps the reader still.
- `src/components/settings-panel.tsx` gains a seventh card. Nothing else on the
  page changes; the card PUTs its own key alone, as decision 0013 requires.

### A cursor, not an offset

Rows are appended while a reader pages, so an offset re-reads and skips. The
cursor is the position of the last row shown, and `ts` alone is not a position:
`ts` is a millisecond epoch and is not unique, so `ts < cursor` drops every row
sharing the boundary millisecond and `ts <= cursor` repeats them. The table's
`id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (`src/lib/db.ts`), monotonic with
insertion, so `(ts, id)` is a total order and the page predicate is exact:

```sql
WHERE t.ts < ? OR (t.ts = ? AND t.id < ?)
ORDER BY t.ts DESC, t.id DESC LIMIT ?
```

`id` therefore becomes part of `TrafficRow`, which the page also needs as a
stable React key and as the identity of the expanded row (today `open` is an
array index, which would point at a different row the moment new rows are
prepended — a bug this change would otherwise introduce). The existing
`traffic_ts` index bounds the scan; no new index is added, because a second
index costs every insert and the cursor scan is already a range on `ts`.

### Retention: pruned on write, never on read

`recordTraffic` prunes after its insert, as it does today, but with
`DELETE FROM traffic WHERE ts < ?` — an indexed range delete, strictly cheaper
than today's `id NOT IN (SELECT … ORDER BY ts DESC LIMIT 500)`, which sorts the
table on every single request.

Pruning does **not** happen in `readTraffic`. Decision 0017's rationale rejects
exactly that — "a read path that triggers a write path on a timer is a bad
trade" — and `/traffic` polls every six seconds. The consequence is honest and
gets written down: a gate that serves nothing keeps its last rows past the
window until the next request arrives or someone hits Clear. The one extra
place that prunes is the settings PUT route, and only when the patch contained
the traffic section, so that lowering the window from the panel takes effect
when the person presses Save rather than whenever traffic next happens.

### Answering the disk argument

A sibling team, on the unmerged branch, made the opposite call for this same log
(memory `3115ea44-1-7fd8b045`): retention as `traffic.maxRows`, default 5,000,
floored — and its `not taken` list rejects a time window in one line, "bounds by
age, not size, and disk is the resource being managed". That objection is real
and this plan answers it rather than walking past it:

- A row is bounded, so a day is bounded. Previews are truncated at 2,000
  characters each (`MAX_PREVIEW`), so worst case a row is roughly 4 KB and
  typically far less. Disk is then traffic × window, not unbounded: 20,000
  served requests in a day is about 80 MB of log, so a week at that rate is
  about 560 MB, and a personal gate is orders of magnitude below it.
- The resource being managed is the person's, and the number is now theirs. A
  row count cannot be reasoned about — 5,000 rows is two hours on a busy gate
  and four months on a quiet one — while "how many days of traffic to keep" is
  the question anyone actually has when they open this page ("what happened
  yesterday?"). The cap at 500 answered that question with "no".
- The floor is 1 day, clamped in `mergeSettings`, so a hand-edited `0` cannot
  turn the log into a table that empties itself, and the panel's field cannot
  either. There is deliberately no "keep forever": that is the unbounded case,
  and it stays unreachable.
- Clear still exists, and the CSV export stays explicitly bounded (below), so
  nothing on this surface tries to hold the whole window in memory.

This reverses two recorded sibling decisions on the person's explicit
instruction: `3115ea44-1-7fd8b045` (rows, not time) and `3115ea44-2-29d6d379`
(the window "is edited in the settings file only", which also kept a
"six settings cards" sentence true). Neither record exists as a file in this
repository — `0030` here is "an optional field may be written as null" and the
highest record is `0032` — so the reversal is recorded as a new record, `0033`,
and no existing record's body is touched.

### The poll that keeps what is loaded

State on the page: `entries` (newest first), `nextCursor`, and the id of the
expanded row. Three paths write `entries`:

- **First load and Refresh** — `?limit=100`, no cursor: `entries` and
  `nextCursor` both come from the response.
- **The 6s poll** — `?limit=100`, no cursor, and then a merge that never
  touches `nextCursor` (overwriting it is the present bug: it throws away every
  page already paged in). New rows are those whose `id` is not held; they are
  prepended. If the fetched page and the held list share no id at all while the
  held list is non-empty, the list has fallen behind by more than a page (or the
  log was cleared), and the page starts over from the fetched page with its
  cursor — merging in that case would leave a silent hole in the middle.
- **Load more** — `?limit=100&before=<nextCursor>`: rows are appended, ids
  already held are dropped defensively, and `nextCursor` comes from the
  response. A `null` `nextCursor` is the end of the log.

There is no button. A sentinel `<div>` after the last row is watched by an
`IntersectionObserver` (viewport root, `rootMargin: "200px"`), and an
in-flight guard held in a ref keeps a single crossing from firing two loads.

### Not moving under the reader

The window is the scroller (`src/app/layout.tsx` has no overflow container), and
prepending rows above the viewport shifts everything down by their height.
Browser scroll anchoring cannot be relied on — Safari has none — so the page
corrects explicitly, keeping the distance from the bottom constant across the
prepend only:

```tsx
const keepFromBottom = useRef<number | null>(null);
// in the poll, before setEntries, when rows will be prepended and window.scrollY > 0:
keepFromBottom.current = document.documentElement.scrollHeight - window.scrollY;

useLayoutEffect(() => {
  if (keepFromBottom.current == null) return;
  window.scrollTo({ top: document.documentElement.scrollHeight - keepFromBottom.current });
  keepFromBottom.current = null;
}, [entries]);
```

Appending older pages at the bottom needs no correction, and a reader sitting at
the top (`scrollY === 0`) is left at the top so new rows simply appear.

### The end of the list is not the end of the traffic

When `nextCursor` is `null` the list ends in a line that says what the log is
rather than implying completeness, because the log holds served upstream
exchanges only — cache hits and refusals (400/401/402/429/503) write no row at
all (memory `3115ea44-4-a03f666e`, design `gateway-pipeline.md`). Wording:
"That is the whole log kept — N days. Cache hits and refused requests are never
logged."

### Verification without a DOM

vitest here is node-only with no component harness, so the page's behaviour is
pinned by `npm run typecheck` and by tests one level down: the library's paging
and pruning, and the route's wire form (`limit`, `before`, `nextCursor`), which
is where every rule the client depends on actually lives. The merge and the
scroll correction are checked by hand on the running page, which is what
"Done when" asks for.

## Assumptions

- The settings panel is on the **home** page (`src/app/page.tsx` renders
  `SettingsPanel`), not the Team page as the task text said; `docs/design/dashboard.md`
  agrees ("The home page carries … six for settings"). The card goes there, and
  that sentence becomes seven.
- The setting is `traffic: { retentionDays: number }`, default 7, floor 1 day,
  schema ceiling 3650 days. The section name matches the sibling branch's
  `traffic` section on purpose, so a later merge collides visibly in one object
  rather than producing two competing settings sections.
- The CSV/JSON export keeps its explicit `readTraffic(500)` bound and gains a
  comment saying why: with no row cap, the whole window could be hundreds of
  megabytes and the export builds its entire body in memory as one string. So
  the export means "the newest 500 rows" now, not "the whole log", and that is
  written into the design doc's pitfalls. If the person wants the whole window
  exported, that is a separate change with streaming in it.
- `id` is exposed on a traffic row and therefore appended as the last CSV
  column. Appending is allowed; reordering is not.
- A malformed `before` cursor is a 400, not a silently-ignored parameter: a
  client asking for older rows and getting the newest page back would duplicate
  rows it already holds.
- Page size stays 100 rows, today's number, and the route clamps `limit` to
  1–500.
- No version bump: nothing under `plugins/` or `src/client/` changes.

## Baseline

`npm test` (vitest, whole suite) in the run's worktree, before any change:

```
Test Files  81 passed | 1 skipped (82)
     Tests  774 passed | 1 skipped (775)
  Duration  12.14s
```

Green. The one skip is `tests/memory-bench.test.ts`, skipped by design. Nothing
was red before the run started. `npm run typecheck` is `tsc --noEmit`;
`npm run docs:check` runs the record's form check and also runs inside
`npm test` via `tests/docs-record.test.ts`. Dependencies are present in the
worktree (`node_modules` is linked from the checkout); nothing was installed.

### One existing test the change breaks, and why

`tests/storage.test.ts` writes traffic rows with `ts: 1`, `ts: 2`, `ts: 3` —
epoch milliseconds, i.e. 1970 — and reads them back. Age-based pruning on
insert deletes those rows in the same call that writes them, so three
assertions there fail until the fixtures use timestamps inside the window. That
is a fixture change (Task 2), not a behaviour concession. `tests/traffic-e2e.test.ts`
goes through `executeMessages`, which stamps `Date.now()`, and needs no change.

## Documentation

- `docs/design/dashboard.md` — rewrite, not append: the "A panel's shape, and
  where its Save is" sentence counts **seven** settings cards; the "Live
  updates" section says how the Traffic page reads the log now (paged, the next
  page loads when the end of the list is reached, the poll merges new rows at
  the top and leaves loaded pages alone); "Key files" gains
  `src/app/traffic/page.tsx`; "Pitfalls" gains the prepend trap (content
  inserted above the viewport moves the reader unless the scroll position is
  corrected, because Safari has no scroll anchoring).
- `docs/design/gateway-pipeline.md` — the accounting paragraph says
  "previews truncated to 2000 characters, 500 rows kept, local only"; it now
  says the log keeps as many days as the traffic retention setting says.
  "Pitfalls" gains: the window is enforced when a row is written, so an idle
  gate holds its last rows past the window until the next request or a Clear.
  The "Decisions" list gains 0033, newest first.
- `docs/decisions/0033-the-traffic-log-is-kept-by-time-not-by-row-count.md` —
  a new record. This is a real choice: a compiled-in bound is replaced by a
  person's setting, in a different unit, and it reverses two decisions a sibling
  team recorded in memory for these same files. All eight sections, logic not
  code. `Supersedes: none — the 500-row cap was a compiled-in constant, never a
  recorded decision here; 0017 keeps its decision, and only a premise in its
  rationale ("at most 500 rows exist") stops being true.` The record names
  `3115ea44-1-7fd8b045` and `3115ea44-2-29d6d379` as the sibling decisions it
  reverses, and Alternatives carries the row-count cap and the disk argument
  with the arithmetic that answers it.
- `CHANGELOG.md` — one line under `## Unreleased`: the Traffic page loads older
  entries as you scroll, and the log is kept for a number of days you choose
  instead of a fixed 500 rows.

`docs/decisions/0017-…` is **not** edited. Numbers must run without a gap, so
0033 is the number.

---

### Task 1: The retention window as a setting

**Files**
- modify `src/lib/settings.ts`
- modify `src/lib/schemas.ts`
- test `tests/traffic-retention.test.ts` (new)

**Do**
- Add to `GateSettings`, after `throttle`/`retry` and before `memory` (order in
  the interface is cosmetic; keep it near the other operational knobs):

  ```ts
  /** How long the local request/response log is kept. Age is the only bound;
   *  there is no row limit. */
  traffic: {
    /** Rows older than this many days are deleted as new rows arrive. */
    retentionDays: number;
  };
  ```
- `DEFAULT_SETTINGS.traffic = { retentionDays: 7 }`.
- `SettingsPatch` gains `traffic?: Partial<GateSettings["traffic"]>`.
- `mergeSettings` gains a `traffic` branch that clamps rather than trusts, in
  the spirit of the `accountPool.strategy` guard above it: take
  `patch.traffic?.retentionDays`, and use it only when it is a finite number,
  as `Math.max(1, Math.floor(v))`; otherwise keep the base value. A hand-edited
  `0`, `-3`, `"7"` or `null` in `~/.gate/settings.json` must not reach the
  pruner.
- `settingsPatchSchema` gains
  `traffic: z.object({ retentionDays: z.number().int().min(1).max(3650) }).partial()`,
  placed beside the other sections, so the API refuses 0 with a 400 instead of
  clamping silently.

**Test** — write first, `npx vitest run tests/traffic-retention.test.ts`.
A `describe("the traffic log's retention window")` block asserting: a fresh
`loadSettings().traffic.retentionDays` is 7; `saveSettings({ traffic: { retentionDays: 30 } })`
returns and persists 30; `saveSettings({ traffic: { retentionDays: 0 } })`
clamps to 1; a patch whose `retentionDays` is not a finite number leaves the
stored value alone; and `settingsPatchSchema.safeParse({ traffic: { retentionDays: 0 } }).success`
is `false` while `{ retentionDays: 1 }` parses.

**Done when** the days are a first-class setting with a default of 7, no value
below 1 can be stored however it arrives, and the new test passes with
`npm run typecheck` clean.

### Task 2: Time-based pruning, no row cap, and a cursor read

**Files**
- modify `src/lib/traffic.ts`
- modify `tests/storage.test.ts` (fixtures only)
- test `tests/traffic-retention.test.ts` (extend)

**Do**
- Delete `MAX_ROWS` and the `DELETE … WHERE id NOT IN (SELECT …)` statement.
- Add `id: number` to `TrafficRow`, and set it **last** in the object literal
  `readTraffic` maps, after `team`. The literal's key order is the CSV header of
  `/api/export?what=traffic`: append, never reorder, and every row sets every
  key.
- Add, with the exact signatures:

  ```ts
  /** Rows older than the retention window are gone. Returns how many went. */
  export function pruneTraffic(now = Date.now()): number;

  /** The position of a row in the (ts, id) order, opaque to the client. */
  export function trafficCursor(row: { ts: number; id: number }): string;   // `${ts}:${id}`

  /** null for no cursor; throws nothing — an unparseable cursor is undefined. */
  export function parseTrafficCursor(s: string | null | undefined): { ts: number; id: number } | null;

  /** Newest first. `before` is a cursor from `trafficCursor`. */
  export function readTraffic(limit = 100, before?: { ts: number; id: number } | null): TrafficRow[];
  ```

  `parseTrafficCursor` accepts `<digits>:<digits>` only and returns `null` for
  anything else, including `null`/`undefined`/`""`, so the route can tell
  "absent" from "malformed" by comparing against the raw parameter.
- `pruneTraffic` reads the window with `loadSettings()` (settings imports
  nothing that imports traffic, so this adds no cycle) and runs
  `DELETE FROM traffic WHERE ts < ?` with `now - retentionDays * 86_400_000`,
  returning the statement's change count.
- `recordTraffic` calls `pruneTraffic()` after its insert, inside the existing
  `try`, keeping the best-effort swallow: a log line must never fail a served
  request.
- `readTraffic` keeps its single `LEFT JOIN`, adds `t.id` to the select list,
  orders by `t.ts DESC, t.id DESC`, and inserts the cursor predicate
  (`WHERE t.ts < ? OR (t.ts = ? AND t.id < ?)`) only when `before` is given —
  two positional-parameter arrangements over one shared SQL string, since the
  driver is used positionally everywhere here. It does **not** prune.

**Test** — write first, `npx vitest run tests/traffic-retention.test.ts tests/storage.test.ts`.
New assertions:
- *no row cap*: with a 7-day window, 600 rows written inside the window are all
  readable — `readTraffic(1000).length === 600`. This is the assertion that
  fails today.
- *pruned by age*: with `retentionDays: 1`, a row stamped `now - 2 days`
  followed by a fresh row leaves only the fresh one; a row stamped
  `now - 2 hours` survives.
- *paging without gaps or repeats*: eight rows with distinct timestamps, read
  in pages of three using `trafficCursor` on the last row of each; the
  concatenation equals the newest-first whole in order, with no id twice.
- *the boundary millisecond*: three rows sharing one `ts`, paged two at a time;
  all three appear exactly once. A `ts`-only cursor fails this.
- *`parseTrafficCursor`* returns `null` for `"abc"`, `"1:"`, `""` and
  `undefined`, and round-trips `trafficCursor`.

`tests/storage.test.ts`: change the three traffic fixtures from `ts: 1/2/3` to
timestamps inside the window (`Date.now() - 3000/2000/1000`), keeping their
relative order so the newest-first assertions read the same. Nothing else in
that file changes.

**Done when** `grep -rn "MAX_ROWS" src/` finds nothing, the log's only bound is
the window, a page can be read from any cursor exactly once, and the whole
suite is green again.

### Task 3: A page on the wire

**Files**
- modify `src/app/api/traffic/route.ts`
- modify `src/app/api/settings/route.ts`
- modify `src/app/api/export/route.ts` (comment only)
- test `tests/traffic-retention.test.ts` (extend)

**Do**
- `GET /api/traffic` reads `limit` (default 100, clamped 1–500) and `before`
  from the query. A `before` that is present but unparseable is
  `NextResponse.json({ error: "bad cursor" }, { status: 400 })`. Otherwise it
  answers

  ```ts
  { entries: TrafficRow[], nextCursor: string | null }
  ```

  where `nextCursor` is `null` when `entries.length < limit` (the page was the
  last one) and `trafficCursor(entries.at(-1)!)` otherwise. `DELETE` is
  unchanged.
- `PUT /api/settings`: after `saveSettings(parsed.data)`, when
  `parsed.data.traffic` was present, call `pruneTraffic()` so that lowering the
  window from the panel takes effect on Save. One comment saying why the prune
  lives here and not in a read path.
- `src/app/api/export/route.ts`: keep `readTraffic(500)` and add the comment —
  the newest 500 rows, deliberately bounded because the body is built whole in
  memory and the window is no longer.

**Test** — write first, same command as Task 2. Import the handlers the way
`tests/memory-forget.test.ts` does and call them with `new Request("http://gate.test/api/traffic?…")`:
a first page of 2 returns 2 entries and a non-null `nextCursor`; the same route
with that cursor returns the next 2, older, with no overlap; the last page
returns `nextCursor: null`; `?before=nonsense` is a 400; `?limit=99999` returns
at most 500. One test PUTs `{ traffic: { retentionDays: 1 } }` through the
settings route with a two-day-old row present and asserts the row is gone
afterwards.

**Done when** the log is readable page by page over HTTP from any cursor, an end
of log is distinguishable from a full page, and a saved window prunes at once.

### Task 4: The Traffic page loads as you scroll

**Files**
- modify `src/app/traffic/page.tsx`
- test: none of its own (node-only vitest, no DOM harness); pinned by
  `npm run typecheck` and by Task 3's route tests

**Do**
- Add `id: number` to the page's local `TrafficEntry` interface.
- State: `entries`, `nextCursor: string | null`, `open: number | null` (now a
  row **id**, not an index), plus refs for the in-flight guard and the scroll
  anchor.
- `load()` (first mount, the Refresh button) fetches `?limit=100` and sets both
  `entries` and `nextCursor` from the response.
- `poll()` on the 6s interval fetches `?limit=100` and merges per the Approach:
  prepend the ids not held and leave `nextCursor` alone; when the fetched page
  and the held list share no id and the held list is non-empty, replace both
  from the response. It must never write `nextCursor` in the merge branch.
- `loadMore()` fetches `?limit=100&before=<nextCursor>`, appends the entries not
  already held, sets `nextCursor` from the response, and is guarded by a ref so
  one sentinel crossing cannot fire it twice.
- A sentinel `<div ref={sentinel} />` after the list, and an effect that
  observes it with `new IntersectionObserver(…, { rootMargin: "200px" })`,
  re-created when `nextCursor` changes and disconnected on cleanup. Nothing
  observes while `nextCursor` is `null`.
- The scroll correction exactly as in the Approach: capture
  `document.documentElement.scrollHeight - window.scrollY` before a prepend when
  `window.scrollY > 0`, restore in a `useLayoutEffect` keyed on `entries`.
- `key={e.id}` on the row, `onClick={() => setOpen(open === e.id ? null : e.id)}`,
  `{open === e.id && …}` for the detail.
- Below the list: while a page is loading, a quiet "loading older entries" line;
  when `nextCursor` is `null`, the end-of-log line from the Approach, naming the
  retained days (read once from `/api/settings`) and saying that cache hits and
  refused requests are never logged. `clear()` empties `entries`, resets
  `nextCursor`, then loads.
- `LiveActivity` above is untouched.

**Done when**, with the app running (`npm run dev`) and more than 100 rows in
the log: scrolling to the bottom loads older entries by itself with no button;
new requests appear at the top within six seconds while the pages already loaded
stay; the row being read does not move when they do; an expanded row stays
expanded and stays the same row across a poll; and the list ends in a line that
does not claim to be the whole traffic.

### Task 5: The retention days in the settings panel

**Files**
- modify `src/components/settings-panel.tsx`

**Do**
- The panel's local `Settings` interface gains `traffic: { retentionDays: number }`,
  and a `trafficOf(s)` normaliser defaulting to 7, following `memoryOf`
  exactly — an older server may answer without the key.
- `OWNS` gains `trafficLog: ["traffic"]`, so the card PUTs that key alone
  (decision 0013).
- A seventh `<Group>`, after Memory: `icon={ScrollText}` (from `lucide-react`,
  added to the existing import), title "Traffic log", description "How much of
  the local request/response log is kept." One `Row` with
  `<Head label="Keep for (days)" hint="Days of traffic log kept; older rows are removed as new ones arrive. There is no row limit." />`
  and a numeric `Input` of the same shape as the Consolidate-after field,
  bound to `trafficOf(s).retentionDays`.
- Update the block comment above `OWNS` and the one above `SettingsPanel`:
  seven unrelated questions now, the new one being how long the traffic log is
  kept.

**Done when** the **home** page shows seven settings cards, the days field saves
on its own Save and persists across a reload, saving it writes only the
`traffic` key, and no other card's Save became dirty because of it.

### Task 6: Documentation

**Files**
- modify `docs/design/dashboard.md`
- modify `docs/design/gateway-pipeline.md`
- create `docs/decisions/0033-the-traffic-log-is-kept-by-time-not-by-row-count.md`
- modify `CHANGELOG.md`

**Test** none (documentation). `npm run docs:check` must pass, and it also runs
inside `npm test`.

**Do** exactly what `## Documentation` above names, in the present tense, with
no "what changed" sentences in either design doc. The decision record's
Alternatives must carry the row-count cap (the sibling team's
`3115ea44-1-7fd8b045`, 5,000 rows, floored) and the settings-file-only knob
(`3115ea44-2-29d6d379`) as options considered and not taken, each with why not,
and the disk argument answered with the arithmetic from the Approach.
Consequences must carry: disk now grows with traffic and is the person's to
bound; an idle gate keeps rows past the window until the next write; the export
means the newest 500 rows, not the window; `id` is now a CSV column; and a
merge of the unmerged `gate/run-3115ea44` will conflict in every one of these
files and this record governs the outcome.

**Done when** both design docs read as the present tense of the feature with no
mention of a 500-row cap anywhere, all eight sections of 0033 are filled with
logic rather than code, `docs/decisions/0017-…` is byte-for-byte unchanged,
`CHANGELOG.md` has its one line under `## Unreleased`, and `npm run docs:check`
is clean. The commit that carries this task names the files in its body:
`Documents: docs/decisions/0033-the-traffic-log-is-kept-by-time-not-by-row-count.md, docs/design/dashboard.md, docs/design/gateway-pipeline.md`.
