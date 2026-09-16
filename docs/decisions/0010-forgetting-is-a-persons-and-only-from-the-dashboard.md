# 0010. Forgetting is a person's, and only from the dashboard

Status: accepted
Date: 2026-09-16
Run: dd427a9

## Context

Memory could be written but not removed. A decision that stops holding is retracted — a soft close, where the row stays and searches skip it — because "what did we believe on date D" needs the closed row to answer. That left the other case with nowhere to go: a record that should never have been written at all. The recorder misread a run, a branch taught as one task was really two, a catalogue entry was a mistake. Those stayed in the tree for good, and every later recall read them.

## Decision

Memory can be deleted — a decision, a feature, or a run's record — through one module, in one transaction per entry point, cascading to everything the record also is. The routes that reach it are on the admin surface only. The client API has none: no agent, no run and no CLI can forget anything. A person presses a button and confirms it.

## Rationale

Deleting is the one memory operation whose damage is silent and unrecoverable. Everything else in the layer adds, or closes a row that stays readable. A wrong delete leaves no trace to notice later — which is exactly the property that makes it unsafe to expose to the things that write memory automatically.

The writers are the risk. The recorder is what produces the records worth deleting, so giving the recorder — or an agent, or a run, or the CLI — a way to delete would let the same misreading that wrote a bad record erase a good one. Keeping the capability off the client API entirely is a stronger guarantee than a permission check, because there is no route to get it wrong through.

A person at the dashboard has the context the decision needs. They can see the record, what it touched and what will go with it, and the confirmation names both what goes and what stays.

Retraction is not a substitute, and neither is delete a substitute for retraction. A retracted decision is history that stopped being true; a deleted one is a thing that was never true. Both are needed, and conflating them loses the ability to answer what was believed at a point in time.

One record is not one row, so a delete has to be a cascade. A decision is also an FTS index row, a row per path it touched, a vector, a number in its team's implementation row, and possibly another decision's `supersedes` pointer and the `valid_to` it closed. A partial delete leaves search answering with rows whose decision is gone, which is worse than not deleting.

A forgotten run keeps a ledger row reading `skipped — forgotten on request`. Skipped rather than absent is what stops *Record earlier runs* from recording it again; without it, forgetting a run would invite the next backfill to write it back.

## Alternatives

Retraction alone, which is what existed. It cannot express "this was never true", and a wrongly recorded decision stays in the tree and in every recall that matches it.

A client API route for forgetting, guarded by a scope or a role. The guarantee then rests on a check that can be misconfigured, and the parties most likely to call it wrongly are the automated ones. A capability that does not exist cannot be granted by mistake.

Delete the decision row only, and let the orphans age out. Search answers from the FTS index and the path rows, so the record would go on being returned with nothing behind it.

Hard-delete a run's execution record along with its memory. A run's decisions outlive the run, and deleting the execution would take the ledger row that stops the record being rewritten.

## How it works

`src/memory/forget.ts` is the only place memory is deleted, each entry point wrapped in one transaction. Deleting a decision recomputes its team's decision count, clears a dangling `supersedes` on any record that pointed at it, and reopens the `valid_to` it had set. Deleting a feature takes every team's page on it, its consolidation history and the decisions filed under it. Deleting a run's record takes its decisions and leaves the ledger row marked skipped.

Three DELETE routes sit on the admin surface — a decision, a feature, a run's record — behind the admin session like everything else under `/api/`. The dashboard puts them on the decision card, the feature detail and the run's memory panel, each behind a confirmation that names what goes and what stays.

## Consequences

Forgetting needs a browser and the admin cookie. There is no scripted cleanup, no bulk delete from the CLI, and a team that wants many records gone does it by hand — deliberately, because the bulk case is where a mistake costs most.

Anything that later needs automated deletion, such as a retention policy, reverses this record and needs one of its own. Retraction remains the automated way for a decision to stop holding.

A deleted record is gone from search, recall and the team's counts at once. There is no undo, and the confirmation is the only guard.

## Touches

- `src/memory/forget.ts`
- `src/app/api/memory/decisions/[id]`
- `src/app/api/memory/features/[id]`
- `src/app/api/executions/[id]/memory`
- memory
- dashboard

## Supersedes

none
