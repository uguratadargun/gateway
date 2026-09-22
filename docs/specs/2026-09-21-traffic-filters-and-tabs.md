Status: done
Branch: gate/run-3115ea44
Decisions: docs/decisions/0034-a-traffic-row-names-the-run-it-came-from.md
Design: docs/design/gateway-pipeline.md, docs/design/dashboard.md

# Traffic: tabs, filters and traceability

## Goal

`/traffic` stacks two unrelated things vertically — a live SSE feed and, with
no heading at all, a polled list of the last 100 rows — and neither can be
narrowed, linked or traced. The page gets:

- **Two top-level tabs** on the one route: the live feed and the request log,
  the selected tab in the URL so a view can be linked and survives a refresh.
  The log tab gets the heading it has never had.
- **Filters on both tabs** — by person, by the account or provider that
  served, and by tier — always on the ids, never on the derived labels.
- **A live feed that names its caller**, which means the activity event has to
  carry who called and who is serving.
- **Traceability, both kinds**: each row names the run and the node it came
  from and links to that run, and each row carries a copyable request id that
  reaches the full exchange.
- **Retention worth filtering**: 5,000 rows instead of 500, read from settings
  rather than hardcoded, with the filtered columns indexed.

Out of scope, each because it was ruled out rather than forgotten: a traffic
row for a response-cache hit (the dead `cache` badge is deleted instead); any
free-text search over request or response bodies; any new settings card or
on-page control for the retention cap; a `team` filter; an
`x-gate-request-id` response header; cross-linking the live feed to the log.
The three `publishActivity` sites inside `sendWithFallback`
(`gateway-core.ts:438`, `:495`, `:519`) stay anonymous — that function's own
options carry no caller and giving it one is a signature change this task
does not need.

## Approach

**The seam that makes the rest possible: attribution moves out of the read
query.** `callerLabel` and `servedByLabel` are private to `src/lib/traffic.ts`
today and take a row shaped by `readTraffic`'s five-way `LEFT JOIN`. The live
feed needs the same two ladders over loose ids. So both move to a new
`src/lib/attribution.ts`, unchanged in behaviour, plus one function that
resolves loose ids by lookup. `readTraffic` keeps feeding them its joined row;
the SSE route feeds them the event's ids. Decision 0017's rule — ids at write
time, names at read time — holds for the feed too, because the naming happens
in the dashboard's own request and never on the gateway's hot path.

**The run reaches the row through the Principal, not through the session.**
This is the choice task item 4 asked to be made and recorded. `withRunToken`
(`src/executions/runner.ts:315`) wraps the *whole* run, so the run's token
already knows its execution, and that token is what a spawned headless Claude
Code authenticates with — which is the bulk of a run's traffic. Joining
through the session cannot see those calls at all:
`workflow_executions.client_session` is the *originating* session, a spawned
child has a session id of its own, and `client_session` is NULL for every
engine-driven run. (The gate-held path alone would be session-derivable —
`gate-provider.ts:29` encodes `workflow:${executionId}` into the session id —
but only that path.) So `Principal` gains one optional `executionId`, set in
exactly two places, and `finalize` writes it to a new `traffic.execution_id`.

**The node is not written; it is resolved.** Nothing knows the node at write
time for a spawned child, and writing it for the gate-held path alone would
make the column mean two different things. Instead `readTraffic` resolves it
from the execution's own steps by timestamp — the inverse of what
`attributeSessionUsage` (`src/executions/store.ts:201`) already does for
usage. One correlated subquery, working for both shapes, and it keeps the
ids-at-write/names-at-read discipline the row already has.

**The request id has to be minted**, because none exists anywhere: there is no
`requestId` in the gateway path, and `traffic.id` is an autoincrement assigned
after the insert. One is minted at the top of `dispatch` and closed over by
`finalize`.

**Filtering is a real `WHERE` with bound parameters.** `readTraffic` takes an
options object instead of a bare limit; `/api/traffic` and `/api/export` both
build that object from the same query parameters, so the Export button
downloads what is on screen. The dropdowns are populated from a facets query
over the *whole* table rather than from the team, accounts and providers
directories — so an option is offered only when it matches something, deleted
accounts and the `local`/`workflow` sentinels included, and the options do not
vanish as the filter narrows.

**Live-tab filtering is client-side** over the events already in the browser.
The bus has one shared replay buffer and no per-subscriber filter, and the
feed and the log are different data — the UI says so and does not pretend one
is a view of the other.

**URL state follows `team-picker.tsx`, not `useSearchParams`.** That module's
comment records why: these pages are statically prerendered and the hook would
need a Suspense boundary around each of them to build. Read from
`window.location.search`, write with `window.history.replaceState`, and delete
a parameter when it is at its default so a clean URL stays clean.

Untouched on purpose: the pool-size guards at `gateway-core.ts:264`
(`recordRateLimit(..., { history: poolSize <= 1 })`) and `:696-698`. They are
what keeps the global rate-limit snapshot pool-only. Nothing here goes near
them.

## Assumptions

Each of the four below was decided by the run, not by the person, from the
planner's recommendation and the repository's record.

- Retention is **5,000 rows**, read from `settings.json` rather than a
  constant, with the filtered columns indexed. The cap is a promise about how
  long real prompts and replies sit on disk (`docs/design/dashboard.md:87`),
  and a row count is bounded on disk in a way a day count is not. The existing
  per-insert `DELETE … WHERE id NOT IN (… LIMIT ?)` shape is kept exactly;
  only the number and its source change.
- A response-cache hit **still writes no traffic row**. The dead `cache` badge
  is deleted, no cache filter is offered, and the log tab says what the log
  does not contain. `docs/decisions/0017:94-98` rejected "a row for every cache
  hit and every refusal" explicitly and not on the merits — it changes what
  the table means and "deserves its own record rather than arriving inside a
  display feature". This is a display feature.
- **No free-text search over bodies.** Three dropdowns plus a lookup by
  request id. A body search would make prompt and reply text a searchable
  index on the one surface already carrying names and email addresses.
- The retention limit is editable in `~/.gate/settings.json` **and nowhere
  else** — no seventh settings card, no on-page control. The person was asked
  this before the run and chose raising the cap and adding indexes over a
  settings-managed limit; a card would also make `docs/design/dashboard.md:50-51`
  ("six [cards] for settings") untrue for a control nobody asked to see.
- Two smaller rulings taken here for lack of anything to ask: a `person` or
  `served` value whose prefix is not recognised is a **400 from the API**, not
  a silently ignored filter; and a filtered export downloads the whole
  filtered log up to the retention cap rather than the fixed 500 it takes now.

## Baseline

`npm test` (which is `vitest run`) in this worktree, run whole before any
planning: **Test Files 1 failed | 80 passed | 1 skipped (82); Tests 1 failed |
768 passed | 1 skipped (770)**, about 11.6s. `npm run typecheck` is **green**.

The single failure is pre-existing and unrelated to this area:
`tests/session-start-shim.test.ts` → "leaves an up-to-date shim alone, and
rewrites one pointing somewhere else", `expected 1789996497461.999 to be
1789996497462` at line 47 — an mtime sub-millisecond precision assertion on
this filesystem. Confirmed deterministic by running that file alone. It is not
this change's to fix and must still be the only failure at the end.

One trap when running the suite: piping `npm test` through `tail` masks the
exit code — it reports 0 while red. Read the summary lines, not `$?`.

## Documentation

This change alters behaviour two design docs describe, and makes a real
choice that reverses a recorded position. The last task writes all of it.

- **`docs/design/gateway-pipeline.md`** — rewrite, present tense: the
  *Accounting* paragraph (lines ~114-123), whose "500 rows kept" is now
  wrong and whose description of the row must name the request id and the
  execution it came from; the *Pitfalls* bullet at line 164, which today says
  the traffic log is a debugging log that under-counts callers — it stays true
  about what is missing and stops implying the row is untraceable; and the
  *Decisions* list at the end, which gains the new record.
- **`docs/design/dashboard.md`** — rewrite the Traffic page's shape: two tabs
  on one route, the filters, what the log tab says it does not contain, and
  the traceability. Two existing sentences are wrong or become wrong and must
  be fixed in the same pass: *Live updates* (line ~69) says the activity feed
  is "which the home page tails" — it is not, `<LiveActivity />` is rendered
  only on `/traffic`; and *What it must never show* (line ~87) should say that
  the log now keeps 5,000 rows, since that is the sentence carrying the
  privacy claim. The "thirteen destinations" count at line 32 stays true —
  the tabs are inside `/traffic`, not new rail entries.
- **`docs/decisions/0034-a-traffic-row-names-the-run-it-came-from.md`** — a
  new record, all eight sections. It carries three linked choices: the
  execution id on the `Principal` rather than a join through the session; the
  node resolved at read time from the step window rather than written; and the
  retention raised to 5,000 with the privacy reasoning. It reverses the
  position in `docs/design/gateway-pipeline.md:164` that the traffic log is a
  debugging log rather than a trace, and it is the record 0017 deferred part
  of — so *Supersedes* says `none` (0017 still holds in full; nothing in it is
  reversed) and *Context* cites 0017's deferral explicitly.
- **`docs/specs/2026-09-21-traffic-filters-and-tabs.md`** — Status, Branch,
  Decisions, Design lines, then what was asked and what counted as done.
- **`CHANGELOG.md`** — one line under `## Unreleased`, which is currently
  empty.

No second decision record: the cache-hit question was answered by keeping
0017's position, which is not a new choice.

---

### Task 1: The caller's name moves out of the read query, and the live feed learns it

**Files**
- create `src/lib/attribution.ts`
- modify `src/lib/traffic.ts`, `src/lib/activity.ts`,
  `src/lib/gateway-core.ts`, `src/app/api/activity/stream/route.ts`,
  `src/components/live-activity.tsx`
- test: create `tests/activity-names.test.ts`

**Do**

Move `callerLabel` (traffic.ts:79-87) and `servedByLabel` (:90-96) into
`src/lib/attribution.ts` **unchanged** — same ladders, same fallbacks, same
`—`. Export them. `readTraffic` imports them and keeps passing its joined row,
so nothing about the log's naming changes.

Add to the same module a resolver for ids that did not come from a join, and
the event shape the stream sends:

```ts
export interface CallerIds {
  keyId?: string | null;
  userId?: string | null;
  accountId?: string | null;
  providerId?: string | null;
}
/** The two labels for loose ids, looked up one row at a time. */
export function nameCaller(ids: CallerIds): { caller: string; servedBy: string };
/** An activity event with its ids resolved; `cache` memoises within one stream. */
export function namedEvent(e: ActivityEvent, cache: Map<string, string>): ActivityEventOut;
```

`nameCaller` does the small `SELECT`s (users, apikeys, accounts, providers by
id) and feeds the two ladders, so a deleted account degrades exactly as the
log's does. It is never called on the gateway's request path.

In `src/lib/activity.ts`, `ActivityEvent` gains the four id fields above, all
optional. Add `export interface ActivityEventOut extends ActivityEvent { caller?: string; servedBy?: string }`
— labels travel on the wire only, never on the bus.

In `src/lib/gateway-core.ts`, four `publishActivity` sites gain the ids they
already have in scope: `:711` (throttle) and `:755` (queue) get
`keyId`/`userId` from `opts.caller`; `:835-848` (the terminal `request` event
in `finalize`) gets all four — `opts.caller?.keyId`, `?.userId`, and the
`accountId`/`providerId` destructured at `:779`; `:902` (cache hit) gets
`keyId`/`userId` only, since nothing served it. Leave `:438`, `:495` and
`:519` alone.

In `src/app/api/activity/stream/route.ts`, build one `Map<string,string>` per
connection and send `namedEvent(e, cache)` in both places the route sends —
the `recentActivity()` replay loop and the `subscribeActivity` callback.

In `src/components/live-activity.tsx`, extend its local copy of the event
interface to match `ActivityEventOut` (it keeps its own copy today; keep them
in step), and render the caller and what is serving on a `request` row — the
person as a `Badge variant="outline"` with the full value on `title`, the
served-by as muted text, both truncated, matching the log row's treatment at
`traffic/page.tsx:91-100`. The component also takes optional filter props;
those arrive in Task 6.

**Test** — written first, `tests/activity-names.test.ts`, asserting
`nameCaller` because that is where the live feed's naming actually lives (the
SSE route is then two lines). Following `tests/storage.test.ts`'s traffic
setup: create a user, a key they own and an account labelled `work`.
- names the person and the account: `nameCaller({ keyId, userId, accountId })`
  is `{ caller: "Alan", servedBy: "work" }`.
- degrades when they are gone: after `deleteAccount` and `deleteUser`,
  `caller` falls back to the key's name and `servedBy` matches
  `/^removed account /`.
- the sentinels: `{ keyId: LOCAL_KEY_ID }` is `local`, `{ keyId: INTERNAL_KEY_ID }`
  is `workflow`, `{}` is `{ caller: "unknown", servedBy: "—" }`.

Run: `npx vitest run tests/activity-names.test.ts tests/storage.test.ts`.

**Done when** the two ladders exist in one module and are used by both
readers; `tests/storage.test.ts`'s existing degradation test passes unchanged,
proving the move was behaviour-free; a live event carrying ids arrives at the
browser carrying names; and `npm run typecheck` is green.

---

### Task 2: The row carries the run it came from and an id of its own

**Files**
- modify `src/lib/db.ts`, `src/lib/apikeys.ts`, `src/lib/run-tokens.ts`,
  `src/providers/gate-provider.ts`, `src/lib/gateway-core.ts`,
  `src/lib/traffic.ts`
- test: modify `tests/traffic-attribution.test.ts`, `tests/traffic-e2e.test.ts`

**Do**

`src/lib/db.ts`: append two entries to `COLUMN_MIGRATIONS` (the array of
`[table, column, ddl]` tuples at :546, traffic's group at :556-565), in the
house style with a comment above saying why they exist and what NULL means on
older rows:

```ts
["traffic", "request_id", "request_id TEXT"],
["traffic", "execution_id", "execution_id TEXT"],
```

Indexes go as separate `d.exec(...)` calls in `getDb()` **after** the
migration loop, beside `usage_session` at :703-707 — they cannot go in the
`SCHEMA` literal, because the columns they index do not exist when `SCHEMA`
runs. Add:

- `traffic(request_id)` — the point lookup.
- `traffic(execution_id)` — the trace, and the join to executions.
- `traffic(user_id, ts)`, `traffic(key_id, ts)`, `traffic(account_id, ts)`,
  `traffic(provider_id, ts)`, `traffic(tier, ts)` — composite, and in that
  order, because every filtered read is "this value, newest first, limit N";
  the composite serves the filter and the ordering together, where five
  single-column indexes would serve only the filter and leave a sort behind.
- `workflow_execution_steps(execution_id, started_at)` — for Task 3's node
  subquery; that table has no index beyond its primary key today.

Seven new indexes on a table written once per served request is deliberate:
each insert gains seven small b-tree writes, against an upstream call of
100ms or more.

`src/lib/apikeys.ts`: `Principal` (:53-58) gains
`/** The run this caller is acting for, when it is one. Trace data: it is never consulted by an authority check. */ executionId?: string | null;`

`src/lib/run-tokens.ts`: `withRunToken` already takes `executionId`. Register
`{ ...principal, executionId }` rather than `principal`, so no caller has to
remember to set it and every request on a run's token carries the run.

`src/providers/gate-provider.ts`: the hardcoded caller at :36 gains
`executionId: req.context?.executionId ?? null` — `ModelProviderRequest.context`
is `{ executionId?; nodeId?; workflowId? }` (`src/providers/types.ts:55`).
The `nodeId` there is deliberately **not** used; Task 3 explains why.

`src/lib/gateway-core.ts`: mint the request id at the top of `dispatch`, where
`finalize` closes over it — `randomBytes(8).toString("hex")`, sixteen hex
characters, matching the shape a key id already has, and short enough to copy
by hand. (`node:crypto` is already imported for `createHash` at :1.) Pass
`requestId` and `executionId: opts.caller?.executionId ?? null` in the
`recordTraffic` call at :818-834. That is the only `recordTraffic` call site
in the codebase.

`src/lib/traffic.ts`: `TrafficEntry` gains `requestId: string` and
`executionId?: string | null`; the `INSERT` gains the two columns and two
placeholders. The insert still swallows its errors — do not change that, but
note the consequence: both columns are nullable `TEXT` precisely so a bad
migration cannot start losing rows silently.

**Test** — written first.

In `tests/traffic-attribution.test.ts`, in the existing describe "a run's own
token at the gateway", one new `it`: a token minted by
`withRunToken("exec-1", principal, …)` resolves to a principal whose
`executionId` is `"exec-1"`, and a principal resolved from an ordinary issued
key has `executionId` null or undefined. This file is where the four scalars
are pinned; the fifth belongs with them.

In `tests/traffic-e2e.test.ts`, one new `it` — "carries the run it came from
and an id of its own": drive `executeMessages` as the existing tests do
(stubbed `fetch`, non-streaming), with
`caller: { keyId, userId, teamId, scopes: ["gateway"], executionId: "exec-1" }`,
then assert on `readTraffic()[0]` that `executionId === "exec-1"` and
`requestId` matches `/^[0-9a-f]{16}$/`. A second call produces a different
`requestId`.

Run: `npx vitest run tests/traffic-attribution.test.ts tests/traffic-e2e.test.ts`.

**Done when** a request made on a run's token leaves a row naming that run;
every new row has a unique sixteen-hex id; a row written before this change
reads NULL for both and still renders; and the existing tests in both files
pass unchanged.

---

### Task 3: `readTraffic` takes a query, and resolves the run and node

**Files**
- modify `src/lib/traffic.ts`, `src/app/api/export/route.ts` (its one
  numeric call)
- test: create `tests/traffic-filters.test.ts`

**Do**

Change the signature from `readTraffic(limit = 100)` to an options object.
Every test calls `readTraffic()` with no argument and keeps working; the one
numeric call site in `src/app/api/export/route.ts:21` becomes
`readTraffic({ limit: … })`.

```ts
export interface TrafficQuery {
  /** Default 100, clamped to 1..the retention cap. */
  limit?: number;
  /** "user:<id>" or "key:<id>" — the person, or the key when there is no person. */
  person?: string | null;
  /** "account:<id>" or "provider:<id>" — whichever answered. */
  served?: string | null;
  tier?: string | null;
  requestId?: string | null;
}
export function readTraffic(q: TrafficQuery = {}): TrafficRow[];
```

The `WHERE` is assembled from bound parameters, never interpolated. `person`
and `served` are one parameter over two columns each, because a caller with no
person has `user_id` NULL and `key_id` set — the sentinels `key:local` and
`key:workflow` are exactly that case, and a served-by is an account or a
provider but never both. A value whose prefix is not one of the four matches
nothing (the API rejects it before it gets here — Task 4).

The `SELECT` gains, beside the five joins it already has:

- `LEFT JOIN workflow_executions x ON x.id = t.execution_id`, for
  `x.workflow_id`.
- a correlated scalar subquery for the node:
  `(SELECT s.node_id FROM workflow_execution_steps s WHERE s.execution_id = t.execution_id AND t.ts BETWEEN s.started_at AND s.finished_at ORDER BY s.step_index DESC LIMIT 1) AS node_id`.
  `ORDER BY s.step_index DESC LIMIT 1` is load-bearing: `BETWEEN` is inclusive
  at both ends, so a request on a boundary millisecond would otherwise match
  two adjacent steps. A step row is written only when the step *finishes*, so
  a call made during an in-flight step resolves to no node until it does —
  that is honest, and the UI shows the run with no node rather than a guess.

The returned object gains four keys, **appended in this order and set on every
row**: `requestId`, `executionId`, `workflowId`, `nodeId`. The comment at
:118-120 is load-bearing — the key order is the CSV header of
`/api/export?what=traffic&format=csv`, read off the first row — so extend that
comment to say these four were appended and that the fifteen before them must
never move.

Add the facets the filter bar reads:

```ts
export interface TrafficFacets {
  /** value is "user:<id>" or "key:<id>"; label is the same ladder the rows use. */
  people: Array<{ value: string; label: string }>;
  /** value is "account:<id>" or "provider:<id>". */
  served: Array<{ value: string; label: string }>;
  tiers: string[];
}
export function trafficFacets(): TrafficFacets;
```

Computed over the **whole** table, never the filtered set, so options do not
disappear as the filter narrows. A row with a `user_id` is offered as
`user:…`, a row with only a `key_id` as `key:…`, so one person appears once.
Labels come from `src/lib/attribution.ts`, so a deleted account is still
offered as `removed account 1a2b3c4d` — it has rows, and a filter that can
reach them is better than one that cannot. Sort by label.

**Test** — written first, `tests/traffic-filters.test.ts`, three describes,
inserting rows with `recordTraffic` directly and calling `clearTraffic()`
around each `it` as `tests/storage.test.ts` does.

- *filtering the traffic log*: rows for two people and two accounts across two
  tiers; `readTraffic({ person: "user:u-1" })` returns only that person's;
  `{ person: "key:local" }` reaches a row with no person; `{ served: "account:a-1" }`
  and `{ served: "provider:p-1" }` each return only theirs;
  `{ tier: "opus" }` narrows by tier; two filters together intersect;
  `{ requestId: "…" }` returns exactly one row; no filter returns everything,
  newest first, as it does today.
- *the facets a filter bar offers*: `trafficFacets()` lists each person once
  with the label the rows carry, lists an account whose row exists but whose
  account has been deleted, and lists only tiers that actually occur.
- *a row names the run and the node it came from*: insert a
  `workflow_executions` row and two `workflow_execution_steps` rows with
  disjoint time windows, then traffic rows with that `execution_id` at
  timestamps inside each window; assert each row's `nodeId` is the right node
  and `workflowId` is the execution's; a row whose `ts` falls in no step's
  window has `executionId` set and `nodeId` null; a row with no
  `execution_id` has all three null and still reads.

Run: `npx vitest run tests/traffic-filters.test.ts`.

**Done when** every filter narrows by id, the node resolves for both run
shapes, and the eighteen existing keys of a row are still in their original
order with the four new ones after them.

---

### Task 4: `/api/traffic` takes the filters, and the export takes the same ones

**Files**
- modify `src/app/api/traffic/route.ts`, `src/app/api/export/route.ts`
- test: create `tests/traffic-api.test.ts`

**Do**

`/api/traffic` `GET` reads `person`, `served`, `tier`, `request` and `limit`
from the URL, validates, and returns `{ entries, facets }`. Validation:
`person` must start `user:` or `key:`, `served` must start `account:` or
`provider:`, `tier` must be one of the four tiers
(`src/lib/router.ts:17`), `limit` must be a positive integer. Anything else is
a `400` naming the parameter — a filter the caller asked for that silently
matches everything is worse than a refusal. `DELETE` is unchanged.

`/api/export` `GET` reads the same five parameters for `what=traffic` and
passes them straight to `readTraffic`, with `limit` defaulting to the
retention cap rather than the fixed 500 it uses now, so a filtered export is
the whole of what was filtered. The CSV path is untouched — it still reads its
header off `Object.keys(rows[0])`, which is why Task 3's key order matters.

**Test** — written first, `tests/traffic-api.test.ts`, importing the route
handlers directly and hand-building `Request`s, as about a dozen suites in
this repository already do (`tests/agent-api.test.ts` is the pattern).

- `GET` with no parameters returns every row plus a `facets` object.
- `GET ?person=user:u-1` returns only that person's rows.
- `GET ?person=nonsense` is a `400` and names `person`; likewise
  `?served=nonsense` and `?tier=nonsense`.
- `GET ?request=<id>` returns exactly that row.
- the export: `GET /api/export?what=traffic&format=csv&tier=opus` returns only
  the opus rows, and **its header line begins with exactly**
  `ts,endpoint,requested,routed,tier,status,stream,fromCache,requestPreview,responsePreview,accountId,providerId,keyId,userId,teamId,caller,servedBy,team`
  followed by the four new columns. This assertion is the guard on the
  load-bearing comment: it fails the moment someone reorders or drops a key.

Run: `npx vitest run tests/traffic-api.test.ts`.

**Done when** both readers of `readTraffic` take the same filters, a bad
filter is refused rather than ignored, and the CSV header is pinned by a test.

---

### Task 5: The retention cap comes from settings

**Files**
- modify `src/lib/settings.ts`, `src/lib/schemas.ts`, `src/lib/traffic.ts`
- test: modify `tests/storage.test.ts`

**Do**

`src/lib/settings.ts`: a new section on `GateSettings`, beside the others,
with a comment saying what the number is a promise about — how long real
prompts and replies sit on disk, on the one surface carrying people's names
and email addresses:

```ts
/** How many served exchanges the local traffic log keeps. */
traffic: { maxRows: number };
```

`DEFAULT_SETTINGS` gets `traffic: { maxRows: 5_000 }`; `SettingsPatch` gets
`traffic?: Partial<GateSettings["traffic"]>`; `mergeSettings` clamps a
hand-edited value the way `memory.consolidateEvery` is clamped at :215 —
`Math.max(100, Math.floor(...))`, so a file that says `0` or `-1` cannot turn
the log into a single row or an unbounded one.

`src/lib/schemas.ts`: add `traffic: z.object({ maxRows: z.number().int().min(100).max(1_000_000) }).partial()`
to `settingsPatchSchema` beside `concurrency` (:47-52), so the one existing
write path cannot set a nonsense value. **No UI change**: no card owns this
key, `settings-panel.tsx` is not touched, and its local `Settings` interface
stays as it is — `accountPool` is already a key no card there owns, so this is
the existing pattern, not a new one.

`src/lib/traffic.ts`: delete the `MAX_ROWS = 500` constant and read
`loadSettings().traffic.maxRows` inside `recordTraffic`, where the prune
already runs. `loadSettings` caches at module level, so this is a property
read, not a file read, and a saved change takes effect without a restart. The
`DELETE … WHERE id NOT IN (SELECT id FROM traffic ORDER BY ts DESC LIMIT ?)`
shape at :70-72 is **kept exactly**; only the bound number changes. That
subquery now walks up to 5,000 index entries per insert instead of 500 — an
index-ordered walk of a few thousand small keys, immaterial beside the
upstream call the row is recording, and the shape was kept on purpose.

**Test** — written first, one new `it` in `tests/storage.test.ts`'s existing
`"traffic + ratelimit (sqlite)"` describe: "keeps only as many rows as the
settings say". `saveSettings({ traffic: { maxRows: 3 } })`, record five rows
with increasing `ts`, assert `readTraffic()` has three and that they are the
three newest. **Restore the setting in the same `it` or an `afterEach`** —
`GATE_HOME` is shared across the whole suite and `loadSettings` caches at
module level, so a cap left at 3 would silently starve every later traffic
test.

Run: `npx vitest run tests/storage.test.ts tests/traffic-filters.test.ts`.

**Done when** a gate keeps 5,000 rows by default, a `settings.json` saying
otherwise is obeyed and clamped, and no page offers a control for it.

---

### Task 6: Two tabs, a filter bar, and the log gets a heading

**Files**
- create `src/components/ui/tabs.tsx`, `src/components/traffic-log.tsx`
- modify `src/app/traffic/page.tsx`, `src/components/live-activity.tsx`
- test: none (see below)

**Do**

`src/components/ui/tabs.tsx` — the primitive the repository does not have yet,
built to match the mode switch at `src/app/agents/[id]/page.tsx:157-173`,
which is the nearest precedent: an outer `div` with
`flex rounded-md border p-0.5` as the track, items mapped from the `tabs`
prop, the selected one `variant="secondary"` and the rest `variant="ghost"`,
each `size="sm" className="h-7 px-2 text-xs"`. Dumb and controlled:

```tsx
export function Tabs<T extends string>(props: {
  tabs: readonly { id: T; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  value: T;
  onChange: (id: T) => void;
}): JSX.Element;
```

It owns no URL state and no data — the page does.

`src/components/traffic-log.tsx` — the polled list moves here out of the page,
matching the `*-panel.tsx` convention. It takes the filter values as props,
fetches `/api/traffic` with them as query parameters, and renders the rows the
page renders today plus:

- the **run**, where the row has one: `Link` to `/executions/<executionId>`
  labelled with the workflow and node (`dev · planner`), or the run alone when
  the node did not resolve. Nothing where there is no run.
- the **request id**, `font-mono text-xs`, with a copy button
  (`variant="ghost" size="icon"` **with `aria-label`**) in the expanded
  detail.
- the `cache` badge at `page.tsx:95` **deleted** — `from_cache` is always 0
  and stays that way.

`src/app/traffic/page.tsx` owns the header, the tabs, the filter bar and the
URL state, and renders `<LiveActivity />` or `<TrafficLog />` by a ternary on
the tab.

- **Tabs**: `live` and `log`. `live` is the default and its parameter is
  deleted from the URL; `?tab=log` selects the log.
- **URL state**, in the shape `src/components/team-picker.tsx:30-60` uses and
  for the reason its comment gives — these pages are statically prerendered
  and `useSearchParams` would need a Suspense boundary around each of them to
  build. Read once on mount from `new URLSearchParams(window.location.search)`
  into state behind a `ready` flag that gates the first fetch; write with
  `window.history.replaceState(null, "", url.toString())`, deleting each
  parameter at its default value. Parameters: `tab`, `person`, `served`,
  `tier`, `request`.
- **Filter bar**, a `Card className="space-y-3 p-4"` above the tab body with a
  `flex flex-wrap items-center gap-2` row, following
  `src/app/memory/page.tsx:160-182`: three `Select`s — person, served by,
  tier — populated from the `facets` the API returns, each with an "any"
  option; one `Input` `w-64 font-mono text-xs` for a request id; and a Clear
  button (`variant="ghost" size="sm"`) shown only when something is set. The
  same bar sits above both tabs and filters both.
- **The live tab filters client-side**, over the events already in the
  browser: `<LiveActivity />` takes the same three id filters as props and
  drops non-matching events from its 40-event window. A tier-filtered live
  feed keeps showing `queue` and `throttle` events, which carry no tier —
  suppressing them would make the feed look dead.
- **The log tab gets its heading** — it has none today — and one line under
  it, `text-xs text-muted-foreground`, saying what the log does not contain:
  cache hits, refusals (400/401/402/429/503), and the proxied `/v1/models`,
  `count_tokens` and `batches/*`.
- **A line saying the two tabs are different data**, not two views of one
  thing: the live feed is this process's last events and is lost on restart;
  the log is what was served, on disk, 5,000 rows.
- **Export** (`page.tsx:69`) keeps being a `window.location.href`, but builds
  its URL from the current filter state so it downloads what is on screen.

**Test** — none. This repository has **no component test harness**:
`vitest.config.ts` sets `environment: "node"`, there is no `jsdom` and no
testing-library dependency, and not one file under `tests/` is a `.tsx`.
Adding one is a larger change than this task and is not what was asked. The
behaviour underneath the components is covered by Tasks 1, 3 and 4; this task
is verified by `npm run typecheck` and `npm run lint`, and by the whole suite
still passing.

**Done when** `/traffic?tab=log&tier=opus` opens the log tab filtered by tier
after a refresh; the same filters narrow both tabs; Export downloads what is
filtered; a row with a run links to it; a request id can be copied and pasted
into the id field to reach that exchange; and the dead `cache` badge is gone.

---

### Task 7: Documentation

**Files**
- modify `docs/design/gateway-pipeline.md`, `docs/design/dashboard.md`,
  `CHANGELOG.md`
- create `docs/decisions/0034-a-traffic-row-names-the-run-it-came-from.md`,
  `docs/specs/2026-09-21-traffic-filters-and-tabs.md`
- test: none (documentation)

**Do**

Write the five documents listed under `## Documentation` above, to the forms
in `plugins/gate/reference/docs.md`. The record was written as `0030`, the
next free number on this branch, and renumbered to `0034` when it merged:
`gate/pipeline-best-practices` took 0030 through 0033 in parallel, and
`npm run docs:check` refuses a number used twice. The design docs are the
present tense of the feature: never "what changed".

The decision record's eight sections carry the logic, not the code. *Context*:
the traffic log could not be traced to the run that caused it, and 0017
deferred part of this deliberately. *Decision*: the execution id rides on the
`Principal`, the node is resolved at read time from the step window, and the
log keeps 5,000 rows. *Rationale*: the run token wraps the whole run and is
what a spawned Claude Code authenticates with, so the Principal is the only
route that sees a run's real traffic. *Alternatives*: the join through
`client_session` — and exactly why it fails, which is that a spawned child has
its own session id and `client_session` is NULL for engine-driven runs;
writing the node at write time, which is knowable only for the gate-held path
and would make one column mean two things; a time-based retention window,
which is not bounded on disk. *Consequences*: the log is a trace now and not
only a debugging log, which is what reverses `gateway-pipeline.md:164`; ten
times as many rows of people's prompts sit on disk behind the admin cookie;
`Principal` carries a field that is trace data and must never be read by an
authority check; a row written before this release reads NULL for the run and
the id and still renders.

The commit for this task names the record in its body on one line:
`Documents: docs/decisions/0034-a-traffic-row-names-the-run-it-came-from.md, docs/design/gateway-pipeline.md, docs/design/dashboard.md`.
No trailers of any kind, in this or any other commit of this branch.

**Test** — none (documentation). `npm run docs:check` checks the record's
form and runs inside `npm test` anyway.

**Done when** both design docs read as the present tense of the feature with
no "what changed" anywhere and the two wrong sentences in `dashboard.md`
fixed; every section of `0034` is filled with logic rather than code; the spec
carries its Status, Branch, Decisions and Design lines; `CHANGELOG.md` has one
line under `## Unreleased`; and `npm test` and `npm run typecheck` both pass
with `tests/session-start-shim.test.ts` as the only failure, exactly as the
baseline left it.
