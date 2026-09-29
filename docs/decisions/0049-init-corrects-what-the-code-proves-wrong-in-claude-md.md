# 0049. /gate:init corrects what the code proves wrong in an existing CLAUDE.md

Status: accepted
Date: 2026-09-29
Run: manual

## Context

`/gate:init` leaves every existing document as it is. `CLAUDE.md` was the one exception, and only so that the record's table could be appended. Every other line stayed untouched.

On `ulak-desktop`, init read the code closely enough to find that the `CLAUDE.md` already there was wrong in several places:

- It named a `ts/components/ppt/` directory that does not exist.
- It listed files that had been deleted.
- It gave a version several releases old.
- It told every session that LiveKit is vendored and must not be imported from npm, while the packages are installed from the team's forks.

Init wrote those findings into the design docs' Pitfalls ("`ts/components/ppt/` in CLAUDE.md does not exist") and left `CLAUDE.md` as it was. Every Claude Code session reads `CLAUDE.md` first and the design docs only later, if at all, so each session kept starting from the wrong map.

## Decision

On an existing `CLAUDE.md`, init appends the record section (when it is not already there) and corrects the lines the code proves wrong:

- a path that does not exist;
- a figure that disagrees with the file that owns it (a version, a runtime, a command);
- a statement of fact about the code that the code contradicts.

Only those lines change, in the file's own language and wording. A rule the code merely breaks is the team's intent and stays. The report lists each correction with the file that proves it. A design doc does not carry a pitfall saying `CLAUDE.md` is wrong.

## Rationale

`CLAUDE.md` is the one file in a repository that every session is made to read. A false line there costs more than a false line anywhere else, and init is the moment when someone has just read the whole repository and knows which lines are false.

Writing the finding into a design doc instead records the error without removing it. The session that needs the correction is the one that reads `CLAUDE.md` and never opens the design doc.

The narrow rule (a line has to be proved wrong by a file) keeps what init has always promised: it does not rewrite a file the repository already has. A person's wording, order and choice of language are theirs, and so is every line init cannot prove false.

## Alternatives

Leave `CLAUDE.md` as it is and report the false lines. The report is read once. `CLAUDE.md` is read every session, so it stays wrong until someone acts on a report they may not remember.

Rewrite `CLAUDE.md` from what init learned. That overwrites the team's own instructions, conventions and emphasis with a model's summary. It is the rewrite init has always refused.

Correct rules as well as facts. "Always TypeScript" in a repository that still has JavaScript is a direction, not an error. Rewriting it to describe the code would remove the instruction it exists to give.

## How it works

Step 1 of `plugins/gate/commands/init.md` names `CLAUDE.md` as the file that gets both the record section and corrections. Step 4 lists what counts as proved wrong, what must not change, and the difference between a false fact and a broken rule. Step 5 has the report list each correction with its before, after and proof. `plugins/gate/reference/docs.md` says the same in its `CLAUDE.md` section.

A second run finds nothing left to correct, so running init twice stays safe.

## Consequences

A repository's `CLAUDE.md` can change in lines other than the appended section. The step 5 report and the diff are where the person sees those changes before the skeleton commit.

A correction can be wrong where init misread the code. The proof named next to each line is how the person checks it.

## Touches

- `plugins/gate/commands/init.md`
- `plugins/gate/reference/docs.md`
- `docs/design/dev-workflow.md`
- init

## Supersedes

none
