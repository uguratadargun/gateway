# 0035. An unfinished run is not a refusal

Status: accepted
Date: 2026-09-23
Run: gate/memory-best-practices (manual)

## Context

A decision's `outcome` said how far the work got, and `abandoned` was the word for every run that did not finish: failed, stopped, or written off when its machine went quiet. The recall brief put those decisions under "Tried and abandoned — a road already found closed", and the planner was told the same in its own prompt.

That merged two different facts. A run stops for reasons that say nothing about its idea: a timeout, a flaky check, a person going home, the run that measured 5960 seconds and was stopped for being slow. Its decisions were then read as refused, and the next planner avoided them. On the live gate, 12 of the 13 recorded decisions were `abandoned`. Among them were the traffic page's design choices, and that work was later merged by hand. Housekeeping was also being recorded as decisions ("update Avatar.test.tsx mocks"), so a planner was told to stay away from a test file.

## Decision

Whether the approach was refused is a field of its own, the decision's `verdict`: `rejected` when the reviewer, the verifier or a person turned the approach down on its merits, with `verdictReason` saying who and why. It is null otherwise, whatever the run's outcome. Only a refused decision is a closed road. An `abandoned` decision without a verdict is an unfinished attempt, and the brief says so. The recorder records no housekeeping.

## Rationale

The reader is a model deciding what not to try, and it takes a label literally. A label that is sometimes a verdict and sometimes a stopwatch makes it avoid good ideas and repeat nothing it learned, because it cannot tell which it is looking at.

Refusal is something a run's steps can show: the reviewer's feedback, the verifier's gaps, the person's words at acceptance. Only the recorder reads those steps, so the recorder names it, per decision. One run can refuse one approach and ship another. A run-level flag could not say that.

The recorder's answer is parsed so that anything but the literal `rejected` becomes null. A model that writes "stopped" or "failed" there is describing the run, and reading that as a verdict would bring back the error this record exists to remove.

## Alternatives

Rename `abandoned` to something softer and keep one field. The run-state half would read better, but a refusal inside a completed run (attempt one refused, attempt two shipped) still has no place.

Derive refusal from the run's terminal node (`review-stuck`, `not-verified`). That is closer, but the terminal says the run gave up, not which of its approaches was refused or why. It is also silent when a completed run refused something along the way.

Drop unfinished runs from recall entirely. What an interrupted run learned is often the most useful record of all. The mistake was the label, not the record.

## How it works

The recorder's prompt asks for `verdict` and `verdictReason` per decision and says what is not a verdict. It also says housekeeping is recorded as nothing. The store keeps both in two columns and keeps the reason only when there is a verdict.

A card carries both fields. The text a model reads marks a refused decision "✗ refused: <reason> — a road already found closed" and labels an unfinished one "abandoned (the run did not finish — not a refusal)". Recall's brief has two sections, **Refused before** and **Unfinished attempts**. The planner prompts say a refused approach is closed and an unfinished attempt is weighed on its merits. The consolidator is told the same, and never describes an abandoned decision as refused. On the dashboard, only the verdict is shown in red.

## Consequences

Decisions recorded before this have no verdict, so they read as unfinished rather than refused. That is the safe direction: a road wrongly left open is re-examined, while one wrongly closed was never looked at again. To get a verdict onto an old decision, record its run again.

Whether a refusal happened is now a model's reading of the steps, where before it was a conflation. The prompt draws the line as narrowly as it can, and the parse drops anything vaguer.

## Touches

- `src/memory/extract.ts`
- `src/memory/store.ts`
- `src/memory/cards.ts`
- `src/memory/consolidate.ts`
- `src/agents/defaults.ts`
- `src/components/decision-view.tsx`
- memory

## Supersedes

none — no record covered what `abandoned` meant to a planner
