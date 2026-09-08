---
description: Analyse this repository and build gate agents and a workflow for it
argument-hint: [what the pipeline should do]
allowed-tools: Bash(node:*), Read, Write, Glob, Grep
---

Agents that already exist in gate:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" agents`

Workflows that already exist:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" list`

How the two file formats work, and what a save will reject:

@${CLAUDE_PLUGIN_ROOT}/reference/authoring.md

The user wants a pipeline for: $ARGUMENTS

If that is empty there is no brief, which is fine: the shipped pipeline already
knows how to plan, implement and review, so what is missing is this project's
own steps. Read the repository, work out what those are, and put a concrete
proposal in front of them rather than asking what they want first.

Build it for **this repository** — but not from nothing. gate ships a team with
`planner`, `implementer` and `reviewer`, each following its skills, and a `dev`
pipeline that plans, implements in a worktree, reviews, commits and opens a
merge request. **That is the base. You write the ends.**

## 1. Use the default team, do not rewrite it

`planner`, `implementer` and `reviewer` are not starting points to improve on.
They know nothing about any particular project on purpose — which is what lets
every pipeline share them — and they carry the skills (brainstorming, using git
worktrees and writing plans; executing plans, test-driven development and
subagent-driven development; requesting code review) that make them behave
like a team rather than three prompts. Their prompts are written against what
those skills do unattended — where a skill would wait for a person, that it
commits as it goes, where its process hands off to the pipeline — so a copy
with a paragraph added is a copy that has to get all of that right again.

So: **name them, never copy them.** Do not write a `my-project-planner` that is
the shipped planner with a paragraph added; if a project genuinely needs
something the planner cannot know, that belongs in the task or in a command
node, not in a second planner. `gate agents` above lists what the team already
has; anything there is yours to reuse the same way.

## 2. Read the repository, and write only what is specific to it

Do not design against assumptions. Establish, from the files:

- package manager and the **exact commands** this project uses to install,
  generate, build, test, lint and typecheck — from `package.json` scripts,
  `Makefile`, `pyproject.toml`, CI workflow files, whatever is really there;
- how it is laid out — where source, tests and config live, whether it is a
  monorepo (then commands may need a `cwd`);
- how changes reach it: the remote's host, the default branch, whether
  `gh`/`glab` is used, what CI runs on a merge request;
- what a change here normally has to satisfy: test conventions, a review
  checklist in `CONTRIBUTING`, generated files, migrations.

What you learn becomes `command` nodes, in three places:

- **Between `base` and the planner** — what a fresh worktree needs before
  anyone can work in it: dependency install, code generation, linking, a build
  that other steps assume. (`pnpm install`, `pnpm build-protobuf`, linking
  `node_modules` — whatever this project really does.) A worktree is a clean
  checkout: if something is needed and is not tracked by git, it has to be a
  node. `base` stays the entry: it records the commit the run started from,
  and everything the run does — the planner's spec included — is diffed
  against it.
- **Between the implementer and `stage`** — this project's real verification:
  its test command, its typecheck, its linter. The implementer already tests
  as it works; this node is the deterministic gate that decides whether the
  change reaches a reviewer at all. Route a failure back to the implementer
  with a labelled edge, and give that loop its own terminal so a test that
  never goes green ends with a reason rather than a ceiling. It goes before
  `stage` and `diff`, so the diff the reviewers see is of a change that passed.
- **At the end** — the merge request. The shipped node uses `glab` when it is
  installed and signed in, and GitLab push options otherwise; if this project is on GitHub, make it
  `gh pr create`, and set the target branch to whatever this repository's
  default actually is (`master` and `main` are both common).

If the repository has no test command at all, say so — the pipeline then has no
deterministic gate, and a review-only shape is the honest proposal rather than
an `npm test` that does not exist.

## 3. Add a reviewer only when the project needs one

The shipped `reviewer` reviews the change as a change. A project sometimes has
a second thing that must be checked every time and that a general reviewer will
not reliably catch: a wire protocol or schema that must stay compatible, a
security surface with rules of its own, a performance budget, a compliance
requirement.

If — and only if — this repository has such a thing, add **at most two**
reviewers, each with its own narrow agent and one job. Then:

- turn the single `reviewer` node into a `parallel` node (`review`) whose
  branches are the default `reviewer` **and** yours, joined at `verdict`;
- give each new reviewer `next: verdict` and the same `verdict` /
  `feedback` output shape as the shipped one;
- give it the same inputs the shipped reviewer takes — `base.stdout` and
  `diff.stdout` at least — and only reading tools. The diff is the working
  tree against the run's base commit, not `base..HEAD`: the implementer may
  have committed some of its work and left the rest uncommitted, and the
  prompt has to say so wherever the reviewer is told to look at git itself;
- `executor: claude-code`, like the shipped one, if it has to read the
  repository around the diff; `timeoutMs: 3600000` either way;
- widen the verdict's condition so every reviewer has to approve:
  `outputs.reviewer.verdict == "approved" && outputs.<yours>.verdict == "approved"`.
  The give-up edge (`visits.planner >= 4`) stays where it is.

The default reviewer stays a branch. It is not replaced, and it is not made
optional.

Its feedback has to reach the planner, or a rejection from your reviewer sends
the run back to a planner that cannot see why. A node may narrow an agent's
inputs, never widen them, so this is the one edit to the shipped `planner` a
design may propose: add `<yours>.feedback?` to its `inputs:` and
`{{inputs.<yours>.feedback}}` on the line under the shipped reviewer's, and
nothing else. Say so in the proposal — saving it needs `--replace` on
`planner`, which is the user's to agree to.

## 4. Propose before writing

Show the user, briefly: the nodes you are adding and where, the real commands
they run and which file you read them from, any extra reviewer and the specific
risk it exists for. One sentence each. Wait for confirmation.

Change the shipped shape only where the repository gives you a reason. The diff
node, the empty-diff edge and the rejection-to-planner route are each there
because the obvious alternative fails in a way that is invisible until a run has
already spent its budget.

## 5. Write it

Definitions live on the gate server and belong to the team, so write the files
first and then save them there. Put them under `.gate-proposal/` in this
repository — agents as `<id>.md`, the workflow as `<id>.yaml` — then:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" push .gate-proposal/*.md .gate-proposal/*.yaml
```

Agents are saved before workflows whatever order you list them in, because a
workflow naming an agent the server does not have yet is refused. Ids are
lowercase letters, digits and dashes, taken from the filename. An id that
already exists is refused unless you add `--replace`; never replace something
the user did not agree to replace — pick another id instead.

The server validates every save, so a wrong definition comes back as `prompt
references undeclared input: nobody.field` or `node "check" references unknown
agent "does-not-exist"`. If it refuses, the definition is wrong: read the
message, fix the file, push again. Do not route around it, and do not write
into `~/.gate` by hand — that directory is a mirror and the next pull erases it.

If the push is refused with **SCOPE_MISSING**, this person's key may read the
team's definitions but not write them. Say so and stop: someone with the
dashboard issues them a key with the author right; nothing here can grant it.

## 6. Check it before you save, then again after

The server validates shape, not sense: it will happily accept a pipeline whose
reviewers cannot see the diff, whose implementer has no timeout, or whose plan
can never be revised. Go through **"Before you save — check every one of these"**
in the reference above, item by item, against the files you just wrote. State
the result — not "checked", but which items you verified and on which files.

Anything you had to deviate from, say so and say why. A deviation you can defend
is fine; a silent one is how a pipeline reaches the user needing hand-editing.

When it is saved, tell the user the workflow id, that `/gate:run <id>` starts it
here, what run input it takes, and that the first run will ask them to approve
the commands it wants to run on this machine. Everyone else on the team gets it
at their next `gate` command. Do not start a run yourself unless they ask.
