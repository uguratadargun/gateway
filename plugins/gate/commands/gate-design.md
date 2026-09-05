---
description: Analyse this repository and build gate agents and a workflow for it
argument-hint: [what the pipeline should do]
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Agents that already exist in gate:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate-workflow.mjs" agents`

Workflows that already exist:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate-workflow.mjs" list`

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

## 3. Write it

Agents first — a workflow that names an agent that does not exist yet will be
rejected:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate-workflow.mjs" save-agent <id> <file.md>
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate-workflow.mjs" save-workflow <id> <file.yaml>
```

Write each definition to a file first, then save it. Ids are lowercase letters,
digits and dashes. An id that already exists is refused unless you pass
`--replace`; never replace something the user did not agree to replace — pick
another id instead.

The server validates every save. If it refuses, the definition is wrong: read
the message, fix that, save again. Do not route around it, and do not write into
`~/.gate` by hand.

When it is saved, tell the user the workflow id, that `/gate-run <id>` starts it,
and what run input it takes. Do not start a run yourself unless they ask.
