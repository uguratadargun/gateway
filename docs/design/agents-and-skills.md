# Agents and skills

## Summary

An agent is one role in a pipeline — planner, implementer, reviewer — written
as a Markdown file a person can read and edit: a few lines of frontmatter say
how it runs, and the body is its prompt. A skill is a process an agent is told
to follow, in the same `SKILL.md` layout Claude Code and the published skill
libraries already use, so a library written elsewhere can be pulled in and
assigned without rewriting it. Both belong to a team and are validated when
saved, so a broken definition fails in the editor rather than an hour into a
run.

## How it works

An agent lives at `~/.gate/teams/<team>/agents/<id>.md`; the file basename is
the id workflow nodes reference (`[a-z0-9-]`, up to 64 characters). The
prompt body is a template with one construct, `{{ some.dotted.path }}`,
substituted by regex against an explicit context — there is no expression
evaluation, so an agent file cannot run code. A node only ever sees what it
declares: `inputs` are dotted paths into upstream node outputs
(`<nodeId>.<field>`), or `input.*` for the run input, and the full state is
never dumped into a prompt. A prompt that reads an undeclared input fails at
save time, not mid-run. A trailing `?` marks an input optional: it renders
empty until the node that produces it has run, which is what makes feedback
loops work — the implementation agent can read the tester's failures on its
second pass without failing on its first.

`output.type: json` is validated against the declared shape; extra keys are
kept, because models routinely add commentary fields. An answer that does not
match is sent back to the model with the exact validation message and asked
for again, up to twice, before the node fails — the expensive work is already
done, only the packaging was wrong. An answer cut off by the output ceiling is
reported as `AGENT_OUTPUT_TRUNCATED`, not as bad formatting; raise `maxTokens`
for agents that return long output.

`model` is a tier alias gate resolves to whatever that tier points at, a
concrete `claude-*` id, or `provider:<name>/<model>` for a configured provider.
Whichever form it takes, the agent file is where the choice is made: gate
serves the model named here and never substitutes another.
`executor` is a separate axis and every combination is valid: `gate` is the
built-in loop, where gate holds the conversation and serves its own tools;
`claude-code` hands the node to a headless Claude Code in the worktree,
pointed at this gate's own gateway, so metering and the run budget are
unaffected. `tools` names what the agent may invoke, in the vocabulary
of its executor — gate's own `read_file`, `list_files`, `search_files`,
`write_file`, `edit_file`, `run_command`, plus `memory_search` and
`memory_feature`, or Claude Code's `Read`, `Edit`, `Grep`, `Bash`. For a
`gate` agent an unknown name fails at save time; for a `claude-code` agent
the names are passed to the CLI, which rejects one it does not know. `asks`
marks an agent whose job is to put
something in front of the person and carry back their answer; a run driven
from a session is paused while such a node is out, and its clock stops.

A workflow's run input is checked before anything starts: `/workflows/<id>`
pre-fills the box with the `input.*` keys its agents read, and a run missing
one is refused with `RUN_INPUT_MISSING` instead of failing at the first node.

**Skills** live at `~/.gate/teams/<team>/skills/<id>/SKILL.md`, a directory
per skill with whatever files the process points at beside it. `name` and
`description` are the two frontmatter fields gate reads; every other key an
upstream file carries is kept, so an imported library that gains a field does
not stop parsing. `skills` on an agent names entries from the team's library
and is how the agent works, not what it may touch: an agent that declares one
is told to follow it every run, and a skill the team cannot resolve is refused
at save time. How it reaches the model depends on the executor, but it means
the same thing either way:

- **`executor: claude-code`** — gate assembles the skills that agent named
  into a throwaway plugin and starts the child with `--plugin-dir`, so each
  one loads as `gate-skills:<id>` with its own files beside it and the harness
  opens it when it is due. The bundle is content-addressed under
  `~/.gate/skill-bundles/` (the twenty newest are kept), so the same set is
  built once and a changed skill gets a new address rather than a stale
  plugin. A plugin rather than files dropped into the worktree, because the
  worktree is the run's deliverable.
- **`executor: gate`** — gate's own loop has no notion of a skill and no way
  to read a file outside the worktree, so the skill's prose is folded into
  the system prompt. Files a skill ships are named and explicitly marked
  unreadable, rather than being pointed at and quietly missing.

Skills were written for a session with a person in it, so a node run headless
is also told that nothing it asks can be answered and what to do instead.
Skills ride along in the client bundle, so a run on a developer's own machine
follows the same process the server would.

Team scoping is the same for agents and skills: a team's own copy of a name
wins, anything it has not written it inherits from the default team's
library, and nothing can write into the fallback — so a team can replace
`brainstorming` with its own without asking anyone and without affecting
anyone. The default team's directories are seeded with the shipped agents the
first time `/agents` or `/workflows` is opened, only when the directory does
not exist yet, so deleting a shipped agent sticks; a team you create starts
empty. A refresh writes back the shipped text of any agent that has drifted,
keeps the `model` and `effort` set on it, and puts the old text under
`<team>/backups/<stamp>/agents/`.

### Pulling a library — the Skills page

The skills worth having are mostly written elsewhere, so gate clones a library
and imports from it as two separate acts. **Sync** fetches into gate's own
clone under `~/.gate/skill-sources/` and changes nothing a team runs;
**Import** copies named skills into the team's library and stamps each with
the commit it came from (`.gate-source.json` beside `SKILL.md`). Nothing an
agent does changes until somebody asks for it. Because the stamp is kept,
every skill on the page says where it stands: *not imported*, *up to date*,
*update available*, or *edited here* — the last being the one an update would
overwrite, said before you press the button, and outranking *update
available* for that reason.

[`superpowers`](https://github.com/obra/superpowers) ships registered and
unpulled, under the `superpowers-` prefix so a second library shipping its own
`brainstorming` does not collide. One Sync, then import what you want:

```
Skills → Superpowers → Sync → browse → pick brainstorming → Import
Agents → planner → Skills → ☑ superpowers-brainstorming → Save
```

A library's skills refer to each other by relative path and by the harness's
namespace (`superpowers:writing-plans`); on import those references are
rewritten to the prefixed ids, in prose files only, so the copies still find
their siblings. Add your own library with a git URL, a ref, the subdirectory
its skills live in and an id prefix. Forgetting a source deletes gate's
clone; the skills already imported are the team's copies and stay.

## File format

```markdown
---
name: Tester
model: sonnet          # tier alias, a concrete claude-* id, or provider:<name>/<model>
effort: medium         # optional: low | medium | high | xhigh | max
maxTokens: 32000       # optional output ceiling; thinking counts against it
skills: [superpowers-test-driven-development]   # optional; see Skills above
inputs: [implementation.diff, reviewer.feedback?]
output:
  type: json           # or: text
  schema:
    passed: boolean
    failures: "string[]"
    notes: "string?"
---

Test this change:

{{inputs.implementation.diff}}
```

The full frontmatter: `name`, `description`, `model` (default `sonnet`),
`effort`, `inputs`, `output`, `executor` (`gate` | `claude-code`), `asks`
(`question` | `approval`; `person` is read as `question`), `tools`, `skills`,
`timeoutMs` (one visit to the node, every tool round included; default one
hour, `0` for none), `maxTokens` (default 8192), `maxToolIterations` (`0` or
unset means no cap, the default). Output field types are `string`, `number`,
`boolean`, `string[]`, `number[]`, `object`, `object[]`, `any`, each with an
optional trailing `?`. Unknown keys are rejected.

```markdown
---
name: superpowers-brainstorming
description: Use before any creative work — explores intent and design before implementation.
---

Ask clarifying questions one at a time. Propose 2–3 approaches with trade-offs.
Present the design and get approval before writing code.
```

## Key files

- `src/agents/types.ts` — the frontmatter schema, output field types, `buildOutputSchema`
- `src/agents/loader.ts` — parsing and validation of an agent file; undeclared-input and unknown-tool checks
- `src/agents/template.ts` — `{{ path }}` substitution with no evaluation
- `src/agents/registry.ts` — the file store per scope, with fallback to the default team
- `src/agents/defaults.ts` — the shipped agents, seeding, refresh with tuning kept
- `src/agents/form.ts`, `src/agents/new-agent-template.ts` — the editor's form model and the starting file
- `src/skills/types.ts`, `src/skills/loader.ts` — the open `SKILL.md` frontmatter, content hashing
- `src/skills/registry.ts` — the skill store per scope, `.gate-source.json` origin stamps
- `src/skills/sources.ts` — libraries: sync, import states, prefixing, sibling-reference rewriting
- `src/skills/inject.ts` — `skillsBriefing` for gate's loop, `buildSkillPlugin` and `skillsDirective` for a spawned Claude Code, the unattended notice
- `src/runtime/executors/agent.ts`, `src/runtime/executors/claude-code.ts` — the two loops the executor field chooses between
- `src/runtime/tools/registry.ts` — the tool vocabulary an agent may name

## Pitfalls

- `tools` is only validated for `executor: gate`. `Read` on a `gate` agent is a save-time error; `read_file` on a `claude-code` agent saves fine and fails when the CLI is handed it.
- A skill declared by an agent must exist in the team's library (own or inherited) or the agent will not save. The shipped `super-*` agents name `superpowers-*` skills; until those are imported, saving one from the editor fails and a run that needs one stops at that node with the reason.
- Under `executor: gate` a skill's supporting files are not readable; only its `SKILL.md` prose reaches the model. A skill whose process depends on its files needs `executor: claude-code`.
- An optional input (`?`) renders as an empty string, not as an absent placeholder. A prompt that says "the tester found: {{inputs.tester.failures?}}" reads oddly on the first pass; write the prompt for both cases.
- `maxTokens` is the ceiling thinking is charged against. A high-effort agent with a small `maxTokens` gets truncated output, reported as `AGENT_OUTPUT_TRUNCATED`.
- Saving from the dashboard rewrites the file through the form model; a frontmatter key the form does not carry would be lost, which is why the form is data with tests rather than JSX.
- An imported skill edited by hand is marked *edited here* and will be overwritten by a re-import; the only protection is the label.

## Decisions

- none recorded yet
