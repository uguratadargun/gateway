---
description: Analyse this repository and build gate agents and a workflow for it
argument-hint: [what the pipeline should do]
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Agents that already exist in gate:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" agents`

Workflows that already exist:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" list`

How the two file formats work, and what a save will reject:

@${CLAUDE_PLUGIN_ROOT}/reference/authoring.md

The user wants a pipeline for: $ARGUMENTS

If that is empty there is no brief, which is fine: design the pipeline this
repository obviously wants — plan, implement, run its own test command, review —
and say that is what you are proposing and why it fits what you found. Do not
stop to ask what they want first; read the repository, then put a concrete
proposal in front of them.

Build it for **this repository**, in three passes.

## 1. Read the repository first

Do not design against assumptions. Establish, from the files:

- language, package manager, and the **exact commands** the project uses to
  test, lint and typecheck — take them from `package.json` scripts, `Makefile`,
  `pyproject.toml`, CI workflow files, whatever is really there;
- how it is laid out — where source, tests and config live, whether it is a
  monorepo (then commands may need a `cwd`);
- what a change here normally has to satisfy: existing test conventions, a
  review checklist in `CONTRIBUTING`, generated files, migrations.

If the repository has no test command at all, say so — the pipeline then has no
deterministic gate, and you should propose a review-only shape instead of
inventing an `npm test` that does not exist.

## 2. Propose before writing

Show the user, briefly: the nodes and how they route, which existing agents you
will reuse, which new agents you will add and why, and the real commands the
`command` nodes will run. Prefer reusing an agent over creating a near-duplicate
of it; add a new one when this repository genuinely needs different knowledge in
the prompt. Wait for confirmation.

Start from the canonical shape in the reference — plan → implement → stage →
diff → test → parallel review → verdict — and change it only where this
repository gives you a reason. It is not a suggestion to improve on: the diff
node, the empty-diff edge and the rejection-to-planner route are each there
because the obvious alternative fails in a way that is invisible until a run
has already spent its budget.

## 3. Write it

Definitions belong to the team and live on the gate server; this machine only
mirrors them, and anything written into that mirror is erased by the next pull.
So write what you designed into files under `.gate-proposal/` in this
repository — agents as `<id>.md`, the workflow as `<id>.yaml` — and hand them
over for the user to add in their dashboard:

- **Agents**, one Markdown file each, frontmatter plus prompt.
- **The workflow**, one YAML file, naming only agents that already exist or that
  you are proposing alongside it.

Ids are lowercase letters, digits and dashes. Reusing an id that already exists
(`gate list`, `gate agents` above) replaces someone else's definition, so pick
another id unless the user asked for a replacement.

Tell the user, in order: the agents to create first (a workflow naming an agent
that does not exist is rejected on save), then the workflow, and that both are
added from **Agents** and **Workflows** in the dashboard — the same validation
runs there, so an invalid definition is refused with the reason. `gate show
<id>` prints what is on the server today, if they want to compare.

## 4. Check it before you save, then again after

The server validates shape, not sense: it will happily accept a pipeline whose
reviewers cannot see the diff, whose implementer has no timeout, or whose plan
can never be revised. Go through **"Before you save — check every one of these"**
in the reference above, item by item, against the files you just wrote. State
the result — not "checked", but which items you verified and on which files.

Anything you had to deviate from, say so and say why. A deviation you can defend
is fine; a silent one is how a pipeline reaches the user needing hand-editing.

When they have added it, `gate pull` brings it to this machine and `/gate-run
<id>` starts it here. Tell them the workflow id, what run input it takes, and
that the first run will ask them to approve the commands it wants to run on this
machine. Do not start a run yourself unless they ask.
