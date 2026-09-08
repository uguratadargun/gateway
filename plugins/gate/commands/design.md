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

## 4. Check it before you save, then again after

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
