---
description: Teach your team's memory a task finished before gate recorded runs, from its branch
argument-hint: [--base <ref>] [what the task was…]
---

<!-- No allowed-tools on purpose: understanding a finished task means reading
     whatever it touched — git history, the code around the diff, a plan file,
     a merge request — and asking the user what the branch cannot say. -->

The branch this checkout is on, read the way a run's branch is — the range from where it was cut
to where it ended, its commits and its files:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" teach`

The user asked for: $ARGUMENTS

## What this is

When a gate run ends, the server's recorder reads what its agents answered — the planner's plan,
the implementer's summary, the reviewers' verdicts — and writes the team's memory of it:
decisions (context, decision, rationale, alternatives, how, consequences, touches), the feature it
belongs to, and the team's summary of that feature. Recall reads that memory before every plan.

Work done before the team used gate has none of that, so the next planner cannot learn from it.
This command fills the gap for one task: **you** read the finished branch and write the account
a run's agents would have left, and `gate teach` sends it to be kept as a finished run and recorded
by the same recorder, in the same format. You write the account; the recorder writes the memory.

## 1. Settle the range

Read what the command printed above.

- If it printed an error, deal with it before anything else:
  - `not connected` — `/gate:login <token>` with a token from the dashboard.
  - `already part of … pass --base` — the work was merged without a merge commit, or the
    checkout is on the default branch. Find where the task began (`git log --oneline`, the
    commit messages, a merge request the user names) and, if it is not clear, ask the user with
    AskUserQuestion. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" teach --base <commit>`.
  - `cannot tell which branch this work was cut from` — pass `--base` with the branch it came from.
- If the user passed `--base` in their arguments, run the command again with it and use that output.
- Check the range is **one task**: the commits read as one piece of work, not a long-lived
  branch carrying several. If it spans several, say so and ask which one to teach (each needs its
  own `--base` and checkout of its last commit), rather than teaching a mixture as one.
- `merged into … by <sha>` means the base was found from the merge — confirm it with a glance at
  `git log --oneline <base>..<head>`.

## 2. Read the work

The account is only as good as your reading, and nobody will check it against the diff later —
the recorder does not see the diff, it sees your words. Read the way a reviewer would:

- Every commit, with its message: `git log -p --reverse <base>..<head>` (for a large range, per
  file with `git diff <base>..<head> -- <path>`).
- The code around the change where the diff alone does not say why — the caller of a new
  function, the state a flag guards, the test that pins a behaviour.
- Anything the history points at: plan or design files in the range, an issue or merge request
  number in a commit message (`gh`/`glab` if they are set up), comments that explain a choice.
- The tests added or changed: they are the best record of what the work promised.

Before writing, look at what memory already knows about this area, so the account can name how it
relates: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" memory search --path <a changed directory>`.

## 3. Ask what the branch cannot tell

The diff says what changed; it rarely says **why this way**, or what was tried and dropped. If the
user's arguments already say what the task was, use that. Otherwise, when something material is
unknown — what the task was for, why the obvious alternative was not taken, a limitation that was
deliberate — ask the user, **once, together**, with AskUserQuestion (natural options where there
are some, their own words through Other). They may not remember; "don't know" is an answer, and
the account then says the reason is inferred. Do not ask what reading the code answers.

## 4. Write the account

Write one JSON object to a file of your own, e.g. `$TMPDIR/gate-teach-<short head sha>.json`,
with exactly these fields (strings; empty string where there is genuinely nothing):

```json
{
  "task": "What the work was for, as the person who asked for it would put it. Required.",
  "plan": "The approach as it was carried out, in order.",
  "decisions": "Each real choice, one paragraph each: what was chosen, why, and what was not taken and why. Say when a reason is inferred rather than stated.",
  "implementation": "How it works now: the flow, the components and what each is responsible for, the states and invariants, the edge cases handled and the ones deliberately not.",
  "verification": "How it was checked: the tests added or run, manual checks the history shows.",
  "pitfalls": "Limits, known bugs, follow-ups, what the next change here must not break.",
  "evidence": "What this account is read from: the commit range, files read, a merge request, the user's answers."
}
```

The same rules the recorder writes by:

- **Logic, not code.** Flows, states, invariants, trade-offs, the shape of data. A file path is a
  fine pointer; a function body is not. Never paste code.
- **One paragraph per real choice**, no padding: a one-line fix has one decision; a task that picked
  a storage model, a retry policy and a conflict rule has three.
- **No invention.** An alternative nobody considered is not an alternative. Where you inferred a
  reason from the code, say so in those words.
- Write for the engineer who opens this in a month asking "why is it like this", and for a sibling
  team building the same thing on another platform. They will not have the diff.

## 5. Teach it

Show the user the task line and one line per decision, and ask with AskUserQuestion whether to teach
it as it is or change something first — this writes to the whole team's memory. Then:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" teach --account-file <file> [--base <ref>]

Pass the same `--base` the range was read with. It sends the account with the commits, the changed
files and the diff, then waits for the recorder and prints the decisions it wrote and the feature it
filed them under. Report that, with the run's link.

- `already worked on this branch` — a gate run recorded this work already; its decisions are on
  that run's page. Tell the user, and add `--force` only if they want it taught anyway.
- Teaching the same branch again (after more commits, or a better account) replaces the earlier
  teaching; it does not add a second copy.
- `the recorder failed` — say what it said; it retries on its own, and the run page has
  "Record again".
