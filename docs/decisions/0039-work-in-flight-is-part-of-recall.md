# 0039. Work in flight is part of recall, and an overlap is told to both people

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

Memory is written when a run ends. Until then a run is invisible to every other team. Two teams can start the same feature on the same morning, each recall truthfully answers "nothing found", and both build it. Tasks (0008) group work only when a person opens one and files runs under it, and nothing is ever pushed to anyone: a team learns of another's work only when its own planner happens to search the right words.

## Decision

Recall's search carries the runs of the tree that are going right now whose task shares enough words with the question. These are other people's runs only: the asking run and the asking person's own runs are left out. The brief puts them first. When a run starts, runs of other teams in the tree and other teams' work taught as unfinished are matched against it the same way, and on a strong overlap both people get one message where they linked gate (Telegram). The match is counted words, not a model.

## Rationale

The running runs are already rows on this server, registered when they start, so "is anyone building this now" needs no new record and no model. The only question is how close is close enough.

Words cut to a six-letter stem match across suffixes in any language a team writes its tasks in. That is cruder than a stemmer, and the same for Turkish and English. Two thresholds serve two readers. A planner sees a looser match (two shared stems and a quarter of the shorter task), because it reads the line and judges it. A person is messaged only on a stricter one (three stems and 40%), because a push that is wrong once is muted forever.

Leaving out the asker's own runs matters: a person's second run is not somebody else's work to coordinate with, and a run would otherwise find itself first.

Deciding who should talk is left to the people. The engine surfaces the overlap and routes nothing on it (0001).

## Alternatives

A model judging whether two tasks overlap. It costs a call per run start, is slower than the start itself, and its judgement would decide who gets interrupted. Counted words are predictable and explainable in one line ("in common: push, notifi, messag").

Make tasks mandatory, so overlap is found by task. 0008 made the task a label on purpose, and most runs have none.

Push to everyone on both teams. The two people who started the runs are the ones who can coordinate. Others hear about it at their own next recall.

## How it works

`inFlight` reads the family's running rows, leaves out teach and merge runs and the asker's, and scores each task against the question by shared stems. `LocalMemoryAccess.search` adds the related ones to the result as `inFlight`, and the client API passes the asking run and person. `gate memory activity` lists every run in flight in the tree.

`scheduleOverlapCheck` runs after a run registers, both server-started and local. `overlapsOf` finds other teams' running runs and `in-progress` decisions over the stricter threshold. `announceOverlap` messages each run's person, or everyone linked on that team when the run has no person, once per pair per process, through the bot's `notify`, which uses the chat's own chain.

## Consequences

A gate without a Telegram bot, or people who have not linked it, get no push. Recall still shows the overlap to the planner.

"Once per pair" lives in the process. A restart can repeat a message for a pair whose runs are both still going.

Task text written as a single vague word ("fix it") overlaps with nothing. That is the right answer for it.

## Touches

- `src/memory/activity.ts`
- `src/memory/access.ts`
- `src/memory/cards.ts`
- `src/app/api/v1/executions/route.ts`
- `src/executions/runner.ts`
- `src/app/api/v1/memory/activity/route.ts`
- `src/telegram/bot.ts`
- `src/agents/defaults.ts`
- memory
- cross-team

## Supersedes

none
