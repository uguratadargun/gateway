# Memory

## Summary

Every run leaves a record of what it decided, why, and how — logic, not
code — with the files it touched, and the next run reads it before it
plans: a feature one team built is found when a sibling is asked for it, a
deliberate decision is not undone by accident, an abandoned road is not
tried again. Older work can be taught in, a wrong record forgotten, and
one team can object to another's decision where its planner will read it.

## How it works

### The idea

```mermaid
flowchart LR
  R1["Run ended"] --> REC["📝 Recorder<br/>what was decided?"]
  REC --> DB[("gate.db<br/>SQLite")]
  DB --> RC["🧠 Recall<br/>fetch the related records"]
  RC --> P["Planner<br/>plan knowing these"]
```

Three layers, each read for a different question: a **decision** is one
run's own account, never rewritten (one that stops holding is retracted,
and its replacement names it in `supersedes`); a **feature** is the
catalogue entry a whole tree shares, with an **implementation** row per
team; an **extraction** is the ledger row saying whether a run is recorded.

### How it is stored

Everything is in `~/.gate/gate.db` on the server. Five tables carry the record:

```mermaid
erDiagram
  memory_features ||--o{ memory_feature_impls : "per team"
  memory_features ||--o{ memory_decisions : "the feature's decisions"
  memory_decisions ||--o{ memory_touches : "the files it touched"

  memory_features {
    text id "offline-sync"
    text name "Offline sync"
    text aliases "çevrimdışı, local-first"
    text org_id "ulak (the team tree)"
  }
  memory_feature_impls {
    text feature_id "offline-sync"
    text team_id "android"
    text summary "how we built it"
    text pitfalls "pitfalls"
  }
  memory_decisions {
    text id "7f3a91c2-1-ab12"
    text execution_id "which run"
    text team_id "android"
    text title "title"
    text decision "what was decided"
    text rationale "why"
    text how "how it works"
    text outcome "shipped / abandoned"
    int valid_to "empty while it still holds"
  }
  memory_touches {
    text decision_id "7f3a91c2-1-ab12"
    text ref "app/sync/merge.kt"
  }
```

| Table | What it holds |
| --- | --- |
| `memory_features` | **The feature catalogue.** The feature's name and its other names. Owned by the root of a team tree, so everyone in the tree reads the same names. |
| `memory_feature_impls` | **One summary per team.** "How android built this, and which pitfalls it fell into." Pitfalls are a field of their own, so a consolidation pass cannot smooth them away. |
| `memory_decisions` | **The decisions.** One row each: title, context, decision, rationale, alternatives, how, consequences, which run, which commits (`base_commit..head_commit`), the repository, how far the work got. |
| `memory_touches` | **The files a decision touched.** One row per path or area, so "decisions about this directory" is an index range rather than a scan. |
| `memory_extractions` | **The recording ledger.** Which run was recorded, which is waiting, whether it failed, what it cost. |

Beside these: `memory_embeddings` (a vector per feature and decision, when
a provider is configured), `memory_consolidations` (the pass ledger), and
`decision_issues` / `decision_issue_approvals` (objections and answers).
Two FTS5 indexes, `memory_decisions_fts` and `memory_features_fts`, use
Porter stemming so "notify" finds "notifications". `outcome` says how far
the work got, no further than the run proves: `deployed`/`merged` (live),
`pr-open` (a merge request opened, nobody watched it land), `completed`
(never offered for merge), `unshipped` (the branch never got that far),
`abandoned` (the run failed or was stopped); `shipped` is what older rows
and taught branches carry. Decisions are bi-temporal — `valid_from`/
`valid_to` for the world, `recorded_at`/`retracted_at` for the row — so
"what held on date D" is a range query.

### Recording

```mermaid
sequenceDiagram
  participant Run as Run
  participant DB as gate.db
  participant Rec as 📝 Recorder
  participant AI as Model (Sonnet)

  Run->>DB: 1. Run ended → a "pending" row in memory_extractions
  Rec->>DB: 2. Set the row to "running" (nobody else takes it)
  Rec->>DB: 3. Read the run's steps, similar features and<br/>earlier decisions on the same files
  Rec->>AI: 4. "What did this run decide?"
  AI-->>Rec: 5. Decisions + feature (JSON)
  Rec->>DB: 6. Find the feature or open a new one (memory_features)
  Rec->>DB: 7. Write the decisions (memory_decisions + memory_touches + search index)
  Rec->>DB: 8. Update the team's summary (memory_feature_impls)
  Rec->>DB: 9. Set the row to "done", record the cost
```

1. **Queueing.** However a run ends — completed, failed, stopped, written
   off after its machine went quiet — a `pending` row is added in the
   statement that closes the run; never a second one for the same run.
2. **Claiming.** The row is set to `running`; SQLite has one writer, so of
   two processes asking at once only one sees `changes: 1`. A `running` row
   whose process died is put back in line after thirty minutes.
3. **Reading.** The **agents' answers** from the steps — plan, implementer's
   summary, reviewer's verdict — not git output and not the recall brief;
   the decision records and design docs the run wrote, read from its diff
   as the added lines of `docs/decisions/*.md` and `docs/design/*.md`; and
   the catalogue's similar features and earlier decisions on the same files.
4. **Asking the model** (`memory.model` in Settings, `sonnet` by default),
   in one message: every real choice is a decision, logic not code, the
   failed attempt too. The answer is JSON: the decisions, and the feature.
5. **The feature.** An existing entry is linked; a new name opens a row, its
   id made from the name and unique within the gate.
6. **The decisions.** One transaction, so a run's record is whole or absent:
   a row per decision, a row per touched path, the text into the index. A
   record or design doc the run wrote carries its own path among the
   touches, so `gate memory search --path docs/decisions/0007` finds it. A
   replaced decision gets `valid_to` — only the run's own team's, same repo.
7. **The summary.** The team's row in `memory_feature_impls` is updated.
8. **Closing.** The row becomes `done` with the count and the cost, on the
   run's page; on an error it becomes `failed` and is retried up to three
   times; **Record again** on the run's page asks once more, and **Record
   earlier runs** on `/memory` queues every finished run with no ledger row.

The recorder is a server-side job, not a node: a node at the end of the
graph never runs for a run that was stopped or failed on its last step —
exactly the runs whose decisions ("we tried X, the reviewer refused it
because Y") the next planner most needs. Agents cannot write to memory.
Updating a summary one run at a time drifts, so after every
`memory.consolidateEvery` new decisions (5 by default; 0 leaves it to the
button on `/memory`) a consolidation pass reads every decision under the
feature for that team, rewrites the summary and the pitfalls whole, and
closes the decisions a later one replaced — `valid_to` set, `supersedes`
filled, nothing deleted; a likely duplicate entry is proposed to a person,
never folded. Every pass is on the feature's page with its cost.

### Teaching work from before

Work finished before the team used gate has no run. `/gate:teach`, on the
finished task's branch, fills that in: `gate teach` works out the range —
the fork point from the default branch, or for merged work the point the
merge brought it in from (`--base` when history cannot say) — and Claude
Code reads the commits and the diff, asks the person only what the branch
cannot tell, and writes the account a run's agents would have left
(`task`, `plan`, `decisions`, `implementation`, `verification`,
`pitfalls`, `evidence`). `gate teach --account-file <f>` sends it; the
server keeps it as a finished run of `gate:teach`, dated at the branch's
last commit, for the same recorder. Teaching a branch again replaces the
earlier teaching; a branch a run already recorded needs `--force`.

### Reading

Recall runs before the planner and asks the server a few questions:

```mermaid
sequenceDiagram
  participant R as 🧠 Recall
  participant API as gate server
  participant DB as gate.db
  participant P as Planner

  R->>API: gate memory search "offline sync"<br/>(with the person's key)
  API->>API: key → team: desktop<br/>tree: ulak, android, desktop, ios
  API->>DB: search memory_features (the ulak catalogue only)
  API->>DB: search memory_decisions (these 4 teams only)
  DB-->>API: matching rows, best first
  API-->>R: Offline sync (android) + its decisions
  R->>API: gate memory feature offline-sync
  API->>DB: memory_feature_impls + that feature's decisions
  API-->>R: How android did it + pitfalls
  R->>API: gate memory search --path src/storage
  API->>DB: rows in memory_touches starting with src/storage
  API-->>R: Nothing recorded
  R->>P: Brief: "Android built this, like so;<br/>don't trust the device clock"
```

**Step 1: who may see what.** The server finds the caller's team from
their key, then that team's tree:

```mermaid
flowchart TD
  U["ulak"] --> A["android"]
  U --> D["desktop ← the caller"]
  U --> I["ios"]
  X["other-company"] --> W["web"]
```

For desktop the readable teams are `ulak, android, desktop, ios`;
`other-company` and `web` never come back. The list is written into the
query — `team_id IN (…)` — never into a prompt. Teams nest by a parent on
the Team page. A decision also carries its repository (`host/owner/name`);
a search from a named repository hides decisions of a different named one.

**Step 2: search by words.** `gate memory search "retry for offline sync"`
becomes (simplified):

```sql
SELECT * FROM memory_decisions
WHERE search_index MATCH 'offline* OR sync* OR retry*'    -- filler words like "for" are dropped
  AND team_id IN ('ulak', 'android', 'desktop', 'ios')     -- your own tree only
  AND retracted_at IS NULL                                  -- retracted decisions excluded
ORDER BY
  team_id = 'desktop' DESC,                                 -- your own team first
  match_score                                               -- then the best match
LIMIT 10
```

A word in the **title** scores highest, then the decision text, then the
touched paths, and the consequences text least; every word is quoted, so a
stray `-` or `:` is not FTS syntax. The same search runs over
`memory_features` on names and aliases. Words miss "alerts" for
"notifications": an embedding model on an OpenAI-compatible provider
(Settings → Memory, `memory.embeddings`) gives every feature and decision
a vector, and a search then fuses word and vector rankings by reciprocal
rank fusion, own team first — over the ids the scope already allowed, so a
vector never widens what a team may read; without a provider the words
answer alone.

**Step 3: search by path.** `gate memory search --path src/storage`:

```sql
SELECT * FROM memory_decisions
WHERE id IN (
  SELECT decision_id FROM memory_touches
  WHERE ref LIKE 'src/storage%'        -- every file under this directory
)
  AND team_id IN ('ulak', 'android', 'desktop', 'ios')
ORDER BY team_id = 'desktop' DESC, valid_from DESC   -- own team first, then newest
```

(Really an index range over `memory_touches(ref, repo_id)`.) `--since 30d`,
`--as-of <date>` and `--feature <id>` narrow by time recorded, time held,
and feature.

**Step 4: opening a feature.** `gate memory feature offline-sync` returns
the feature, **every team's** summary and pitfalls (own team first), every
decision under it and the objections against them.

**Step 5: rows become text** for the model:

```text
Features in the catalogue that match:
- offline-sync — Offline sync (also: çevrimdışı) · built by: android

## Çakışmada sunucu sürüm numarası kullan
id: 7f3a91c2-1-ab12 · team: android · shipped · from 2026-08-10
decision: İki cihaz aynı kaydı değiştirirse sunucudaki sürüm numarası kazanır.
why: Cihaz saatleri güvenilir değil, veri kaybı oluyordu.
how: Değişiklikler cihazda kuyrukta bekler, bağlantı gelince sırayla gönderilir...
touches: app/sync/merge.kt
```

A closed decision carries `(no longer holds)` beside its dates; objections
come last, never folded into the decisions above. The same reads exist as
the `memory_search` and `memory_feature` agent tools (on the server, or
over HTTP with the person's key) and as `gate memory search …` / `gate
memory feature <id>` in a session; `/memory` on the dashboard is the same.

### What recall searches, and what it writes into the brief

Three angles, three to six searches in all: **by the feature's name** and
its other names ("offline sync", "çevrimdışı", "local-first"); **by the
directories to be touched** (`--path src/storage`); when something broke,
**by the recent past** (`--path src/sync --since 30d`). The brief is under
about six hundred words, in these sections, any empty one left out: **Same
feature elsewhere**, **Earlier decisions in these areas**, **Objections
standing against us** (first, when any), **Tried and abandoned**, **Runs
that touched this** (run id, commits, date, one line each, newest first),
and **Nothing found** — one line, a real answer. `sources` lists every id
cited, `objections` every open objection. Recall's one rule: only what
came back from the database, no guesses, every claim with its id. The
planner then **adapts** a sibling's method with their pitfalls, **follows**
a decision that holds in these files or says explicitly that it changes
it, **does not go** down a road already found closed, else plans from code.

### Objections between teams

Only a team may close its own decision. An objection is how a sibling says
"this does not work on our side" where the sibling's next planner will read
it. When the shipped planner finds another team's decision cannot be lived
with here, the run puts the objection to the person (`conflict-review`),
and nothing reaches the other team until they confirm. It is written with
the step that raised it as `proposed`; a confirmation makes it `open`, the
state the target team's recall is shown; it never writes `valid_to` on
somebody else's decision. The team objected to may `resolve` it, the
raising team `withdraw` it, a person `reject` it; it is found by its paths
and feature. An answer whose objection never reached the server is kept
and counted, and the count is shown to recall, so an empty list is not read
as agreement. When memory cannot answer another team's question about
code, `gate ask "<question>" --repo <host/owner/name>` runs the `ask`
pipeline over that team's published source at one fixed commit.

### Forgetting

A record that should never have been written — the recorder misread a run,
a taught branch was two tasks, a catalogue entry was a mistake — is deleted
from `/memory`, and the delete takes everything that pointed at it: the
full-text row, the touched paths, the vector, the team's decision count,
another decision's `supersedes` pointer, and the `valid_to` it had closed,
so the decision it replaced holds again. Three units: one decision, one
run's record (**Forget** on a run's page), and a feature with every team's
page, its consolidation history and its decisions. The run is never
touched; its ledger row is left saying `skipped — forgotten on request`,
so only **Record again** brings it back. The client API has no delete, so
no agent, run or CLI can forget anything.

### Who decides what

| Decision | Who makes it |
| --- | --- |
| Is the run recorded? | **Code** (every run is) |
| Which decisions were made, and how are they written? | **The recorder** (a model) |
| Which feature does the work belong to? | **The recorder** proposes, **code** checks |
| Who may see which records? | **Code** (key → team tree → query) |
| Which record comes first? | **Code** (own team first, best match first) |
| What to search for, what to put in the brief? | **Recall** (a model) |
| How the brief shapes the plan? | **The planner** (a model) |

## Key files

- `src/memory/types.ts`, `store.ts` — the three layers and outcome values; the tables and the one way to read them, through a scope in the SQL; the extraction ledger
- `src/memory/extract.ts`, `queue.ts` — the recorder (steps, docs in the diff, neighbours, the prompt, the write) and when it runs, with the consolidation and embedding passes after it
- `src/memory/teach.ts`, `forget.ts`, `consolidate.ts`, `issues.ts` — teaching, forgetting, consolidation, objections
- `src/memory/hybrid.ts`, `embeddings.ts`, `cards.ts`, `access.ts` — words and vectors fused; the shared shapes and the text a model reads
- `src/runtime/tools/memory-tools.ts`, `src/client/memory.ts`, `src/client/cli.ts` — the two read tools on the server and over the client API; `gate memory`, `gate teach`, `gate ask`
- `src/lib/db.ts` — the DDL and the FTS indexes; `src/app/api/memory/`, `src/app/api/v1/memory/`, `src/app/api/executions/[id]/memory/` — the routes

## Pitfalls

- Decisions are recorded once a run has ended; a search during a run does not see it, and a run that stopped at recall leaves nothing.
- Supersession is per team and per repository: a run cannot close a sibling's decision, and "we switched to X" in one repository does not close the other's.
- `pr-open` is not `shipped`; nothing in gate watches whether a merge request landed.
- Retracting and forgetting differ: a retracted decision still answers "what held on date D"; a forgotten one is gone and its ledger row says so.

## Decisions

- [0010 — Forgetting is a person's, and only from the dashboard](../decisions/0010-forgetting-is-a-persons-and-only-from-the-dashboard.md)
- [0007 — A repository is named by its remote, and unknown is never guessed](../decisions/0007-a-repository-is-named-by-its-remote.md)
- [0003 — Ask answers from one commit](../decisions/0003-ask-answers-from-one-commit.md)
- [0002 — Objection record instead of messaging](../decisions/0002-objection-record-instead-of-messaging.md)
