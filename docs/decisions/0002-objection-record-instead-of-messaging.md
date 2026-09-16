# 0002. Objection record instead of messaging

Status: accepted
Date: 2026-09-15
Run: 615c987 (docs: the note the plan was cut from, kept for its reasons) / 899f1d0 (gate: 0.36.2 — a team learns when another team cannot live with its decision)

## Context

Under `ulak` there are four teams: `desktop`, `ios`, `mobile` and `sunucu` (the server team). Separate repositories, separate runs, different days. What happened on the postquantum task was this:

1. desktop went ahead, finished its work in one run, and the recorder wrote its decisions to memory.
2. Days later the server team's planner read desktop's decision from memory and said *"this usage does not fit my structure"*.
3. It asked the person (`asks`), and the person **confirmed it was wrong**.
4. And that confirmation **went nowhere**. It stayed in the server team's run transcript. desktop never learned; nobody recorded that a revision was needed.

What was missing was not a messaging layer. What was missing was **a durable place where one team's conclusion reaches another team**.

A second, rarer need: the server team's run should be able to ask *"how did desktop do this in code"* — and nobody from desktop may be at a computer.

## Decision

A disagreement between teams is a record, not a message. When a run concludes that another team's decision does not fit its own structure and **the person confirms it**, an objection record is opened: owned by the team whose decision it is, bound to the affected paths so that the owner's next `recall` finds it whether or not a task label was given, and closed only by that owner. The source decision card stays where it is and is marked contested, with the objection beside it. A question to a team nobody is awake on is answered by a short-lived, read-only run in that team's repository (`gate ask`), with citations, not by a message. Local runs push their branch when they finish, so there is something to read.

## Rationale

The principle left after the refusals below: **reading agents are free, the writer is one.** Extra agents are no problem as long as they bring information; the actions that change state stay single-threaded.

The source of the objection is not a new tool. The server team's planner already asked the person with `asks`; what opens the record is the **confirmed answer** to that question. There is no "we add a tool and the agent forgets to call it" risk — the mechanism has already fired.

Bound to the path, not to the task. Memory already has `--path` prefix search; if the item is bound to the affected paths, the normal `recall` node brings it up even when desktop never typed `--task`.

The opener cannot close. The server team opens, desktop closes. Single-writer principle.

No new writer is invented at closure. When desktop makes the revision, the existing recorder (`src/memory/extract.ts`) already writes the decision card when the run ends; the item is attached to that run and closed.

The objection does not **delete** the source memory card. The card stays — desktop really did it that way; the card is not wrong, it is *overtaken*. The server team does not **edit** desktop's card; the single-writer principle holds in memory too. `forget` (0.36.1) is the wrong tool here: it is for a wrong record, and this record is not wrong. This also solves **staleness**: a mechanism that says a decision no longer holds keeps cards from quietly becoming false.

For the answerer, a citation is mandatory: an answer that cannot show its source is not an answer but a guess, and is labelled as one; otherwise a hallucination spreads across four repositories at once. `--as-of` is required, because a default of `main` would be wrong — postquantum on desktop is not on main, it is on an unfinished branch — and without the parameter the system would quietly say "no such thing", the worst kind of error. The boundary is `teamFamily`, the same as memory's; a second access rule confuses and leaks. The asker pays, so the answering team's budget is not drained by other people's questions.

The push is justified because `src/runtime/workspace.ts` already says *"The branch is the deliverable"* and the branch holds the work after the worktree is gone; pushing makes it genuinely deliverable and does not leave the answerer confined to the diff. The diff already reaches the server with `/finish` (`setExecutionDiff`), but a diff shows only the changed lines, and *"how did they do it"* usually wants the code around them too.

## Alternatives

Free messaging between agents (a mesh). It hands routing to the model. gate's constitution: *"The engine — never a model — decides which node runs next"* (`src/workflows/types.ts`).

Live parallel agents asking each other questions. A measured failure mode: agents conform to the majority position (sycophancy cascading), and the one benefit of parallelism — independent judgement — is lost.

An orchestrator run that lives for days. A run lasts hours; a task lasts weeks. The orchestrator has to be a **record**, not a run.

Three separate planners. Given the same tools and context, a single agent matches multi-agent in most cases. Pluralising should not be done without measurement.

## How it works

**Task label.** `/gate:run ... --task postquantum`. A free slug, not predefined; the first use creates it. It binds the run to a task; runs from several teams may carry the same label. `workspace.branchPrefix` derives from it: `gate/postquantum-<8>`. Branches describe themselves, and a person can see them with `git branch --list 'gate/postquantum-*'`. **Critical: correctness must not depend on it.** If the label is forgotten the system must keep working (path-based matching below). The label makes things nicer; it does not hold them up.

**Objection record.** The record as designed:

```
Dispute {
  id
  task            string?          // the --task label, if any
  raisedBy        teamId           // sunucu
  owner           teamId           // desktop — only it can close
  paths           string[]         // affected paths; recall finds by these
  feature         featureId?
  disputes        memoryCardId?    // which decision it contests
  what            string           // "the postquantum key exchange is called like this"
  why             string           // "does not fit the server's structure: ..."
  suggestion      string?
  evidence        { executionId, file, line }[]
  confirmedBy     userId           // the human confirmation — the reason the record exists
  status          open | resolved | withdrawn
  resolvedBy      executionId?
  openedAt / resolvedAt
}
```

**Contested card.** The objection lands beside the source card as a separate record, and `recall` brings the two together: *"desktop did this like so; the server team said it does not fit its structure, confirmed on 15 September, item open."*

**Answerer — `gate ask`.** A way to get an answer without anyone on the other team being awake. Not a message: **a short-lived, read-only run in the target team**.

```
gate ask <team> "<question>" [--as-of main | --run <execId> | --task <slug>] [--json]

->
{
  answer       string
  citations    { repo, ref, file, line, excerpt }[]   // mandatory
  basis        "memory" | "previous-answer" | "run"
  confidence   high | low
  needsHuman   boolean
  costUsd      number
}
```

Three tiers, cheapest first; if one holds, the rest do not run: (1) `memory_search` in family scope — free, already working; (2) an answer given before, if the target commit has not changed; (3) an answerer run that actually reads the repository. `executor: claude-code`, because its repository-reading tools are better and it compacts its context (`src/agents/types.ts`, the rationale on the `executor` field). The answer is written to memory, so the second time it is asked it ends at tier 1.

**Branch push.** Local runs (`/gate:run`) push their branch to the remote when they finish. **Mind CI:** pushing `gate/*` branches may trigger a pipeline; before pushing, make sure the CI rules leave these branches out (on GitLab a push option can skip it too).

**Postquantum, end to end.**

1. `desktop` → `/gate:run dev "postquantum ..." --task postquantum`. Branch `gate/postquantum-a1b2c3d4`, pushed when done; the recorder writes the decision card.
2. `sunucu` → `/gate:run dev "postquantum ..." --task postquantum`. `recall` brings desktop's card. The planner sees the mismatch and asks the person.
3. The person confirms → **an objection record is opened**: `owner: desktop`, the affected paths, `disputes: <desktop's card>`. desktop's card is marked contested. The server team carries on with its own work; nobody waits, nobody has to be awake.
4. *(if needed)* the server team's run says `gate ask desktop "... how is it called?" --task postquantum`; the answerer reads desktop's branch and returns an answer with citations.
5. desktop opens its next run. `recall` brings the **open item** bound to those paths — even if `--task` was never typed. The revision becomes part of the plan.
6. desktop finishes the revision; the item is attached to that run and closed, the recorder writes the new decision card, the contest is marked resolved.

**Prerequisites.** Repositories were not registered with gate: none of the four was in `src/repos/store.ts`, and `RepoRecord` had no `team_id`, so the team↔repository link did not exist at all. `gate ask desktop` could not know which repository to read, and the server has no checkout of that code. Needed: registration of repositories **by git URL** (not local path — the server has to be able to fetch) and a team↔repository link (a team may have several repositories). This blocks only the answerer; the objection record and the contested card work with today's setup. The four teams are set up under `ulak`; memory is on and the recorder runs.

**Stages.** Slice 1 — objection record, contested card, and `recall` bringing the items. That was the only thing that failed on postquantum; question-and-answer never failed. It needs no new repository registration, no new protocol, no new node type. Slice 2 — `gate ask` and the answerer: repository registration first, then branch reading with `--as-of`, mandatory citations, the three-tier answer. Slice 3 — the `--task` label and branch naming; 1 and 2 are correct without it, so it can come last, for grouping and readability. Slice 4, subject to measurement — shared planning: a repository-less epic run under `ulak` (`src/executions/runner.ts:137` already supports a run without a workspace) and **one** planner with read access to four repositories through `gate ask`. Three planners only once it is *seen* that one planner's context window does not hold it, or that the platform-specific part of the plan gets rejected.

**Measurements, from the start** — added later means never added: questions per topic (a repeated question is the signal that a written decision is needed); the source of the answer, memory / previous answer / run; the number of open items and the time to closure; cost per ask.

## Consequences

Open at the time of writing:

- **A live run's diff is not visible.** Step records stream, but the diff only goes at `/finish`; "what is desktop writing right now" cannot be seen, only finished runs. Accepted for now; if needed, `RunReporter` sends the diff periodically.
- **Raising an objection depends on the person.** If the planner does not notice, or the person does not confirm, no record is opened. Chosen deliberately, to avoid false positives, but the missed cases cannot be measured.
- **Showing a contested card in recall** will take room; card plus objection together can bloat the context. A short form is needed.
- **Ownership of the decision card** stays with desktop at closure; whether a shared decision should be written to the `ulak` scope will be asked again later.

Where the implementation (the plan, `multi-project-plan.md` v7, and 0.36.2) is known to have departed from this note:

- The `Dispute` record was written as `decision_issues`; the field names differ (`conflictKey`, `targetTeamId`, `sourceNodeId`/`sourceVisit`), and what opens the objection is not the person's confirmation but **a protocol field in the node's own output** — the confirmation arrives as a separate step.
- Of the prerequisites, repository registration now exists and repositories are named by a canonical `repoId`; the team↔repository link is built in Package 2.
- The slices were re-cut as Packages 1–5 in the plan.

## Touches

- `src/memory/` — the objection record, the contested mark, the set `recall` returns
- `src/client/cli.ts` — `gate ask`; `gate memory` (`:916`) is the exact precedent: *"the memory tools, for a person and for the session driving a run"*
- `src/runtime/tools/registry.ts` — the same capability in engine mode
- `src/client/run.ts` / `src/client/step.ts` — `--task`, branch name, push
- `src/runtime/workspace.ts` — push after `releaseRunWorkspace`
- `src/repos/store.ts` + `src/lib/db.ts` — team↔repository link (Slice 2)
- `plugins/gate/commands/run.md` — session mode's behaviour lives largely here

## Supersedes

none

Translated from docs/takimlar-arasi-tasarim.md, which this record replaces.
