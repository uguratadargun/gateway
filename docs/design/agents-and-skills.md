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

`output.type: json` is validated against the declared shape when the answer
is handed back with `gate step`; extra keys are kept, because models routinely
add commentary fields. An answer that does not match is refused with the
exact validation message and the node stays open: the session keeps the file,
fixes it and hands it back. The expensive work is already done, only the
packaging was wrong.

`model` is a Claude model: an alias the person's Claude Code resolves
(`haiku`, `sonnet`, `opus`, `fable`) or a concrete `claude-*` id. A
`provider:` reference is refused when the agent is saved, because every node
runs on the person's own Claude login and nothing there can reach another
provider. The editor offers the four aliases and `claude-fable-5-1`,
`claude-opus-5-5`, `claude-sonnet-5` and `claude-haiku-4-5-20251001`.

`executor` says who does the node in a run the person's session drives. `gate` is the session itself, with
its own tools and its own model, in front of the person: `model` names
nothing that runs there. `claude-code` is always a subagent of the session,
in the agent's own `model`, started from the file gate keeps for the agent
under `~/.claude/agents/` (`gate-<team>-<agent>`), with a context of its own.
`tools` names what the agent's role uses, in the vocabulary of its executor
— gate's `read_file`, `list_files`, `search_files`, `write_file`,
`edit_file`, `run_command`, `memory_search`, `memory_feature` and
`memory_history`, or Claude Code's `Read`, `Edit`, `Grep`, `Bash`. It is the
shape of the job, reads for a reviewer and writes for an implementer, and
nothing hands out or withholds a tool by it. The memory names are the one
place it becomes concrete: a session doing a node whose agent names one is
told to run `gate memory search`, `gate memory feature` or `gate memory
history` in its place. For a `gate` agent an unknown name fails at save
time; a `claude-code` agent's names are not checked, and its subagent file
carries none. `asks` marks an agent whose job is to put something in front of
the person and carry back their answer. Only a `gate` node can: the session
is told to ask with AskUserQuestion, the run is paused while the node is out,
and its clock stops. A `gate` node whose agent has no `asks` is told to settle what
the brief leaves open itself and say so in its answer.

A workflow's run input is checked before anything starts: the `input.*` keys
its agents read are required, `/workflows/<id>` pre-fills the box with them,
and a run missing one is refused with `RUN_INPUT_MISSING` instead of failing
at the first node. A key that only an edge guard reads — `dev-auto`'s
`deliver`, which decides whether the run stops at the commit or opens a merge
request — is optional: it changes where the run goes, not whether it can
start, so it is never pre-filled and can never refuse a run. `gate list`,
`gate show` and `/workflows/<id>` all name it beside the required keys, each
time saying it is optional.

**Skills** live at `~/.gate/teams/<team>/skills/<id>/SKILL.md`, a directory
per skill with whatever files the process points at beside it. `name` and
`description` are the two frontmatter fields gate reads; every other key an
upstream file carries is kept, so an imported library that gains a field does
not stop parsing. `skills` on an agent names entries from the team's library
and is how the agent works, not what it may touch: an agent that declares one
is told to follow it every run, and a skill the team cannot resolve is refused
at save time. It reaches both executors the same way. The skill's directory
comes down with the team's definitions, which every `gate` command pulls, and
a run pins its copy when it begins; the node's instruction names each skill's
path in that copy. The session doing an `executor: gate` node is told to open
each `SKILL.md` and follow it, and to talk to the person where the skill says
to. The subagent of an `executor:
claude-code` node is told, in its task, to read and follow each one before
starting. Either reads the files a skill points at beside it, because they
are on disk. A skill this machine did not pull stops the node before it is
handed out, with `gate pull` named as the way back.

A `claude-code` node is also told three things about where it runs, beside
whatever its own prompt says. Skills were written for a session with a person
in it, and a subagent cannot reach the person, so the node is told it runs
**unattended**: nothing it asks can be answered, and what to do instead. It
is told what dispatching **subagents** costs: never a command whose only
purpose is to let time pass, never a subagent type that copies its own
context — measured here, four dispatches became sixteen that way, because the
copy carried the instruction to fan out — and every subagent it started named
and accounted for before it gives a final answer. And it is told to read
**files** with Read, Glob and Grep rather than the shell: each Bash call
opens a shell, and a file read through one does not count as read, so the
next Edit to it is refused.

Those notices are issued at exactly two sites. The unattended notice goes
with the prompt `gate next` hands a `claude-code` node
(`src/client/step.ts`), because it is true of the node. The other two are
baked into the subagent file `src/client/subagents.ts` writes, because they
are true of every subagent whatever the node is. An `executor: gate` node
gets none of them: the person is right there, and a skill that asks should
ask. The invariant is about the sites, not the count: a notice added to one
agent's prompt instead reaches only that agent, and `tests/inject.test.ts` is
what says the subagent file carries its two.

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
model: sonnet          # haiku | sonnet | opus | fable, or a concrete claude-* id
effort: medium         # optional: low | medium | high | xhigh | max
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
`timeoutMs` (how long one visit to the node is expected to take; past it the
person is told the node is overrunning, and stopping it is theirs; default one
hour, `0` for no notice), `maxTokens` and `maxToolIterations` (accepted, so an
older agent file keeps loading, and read by nothing). Output field types are
`string`, `number`, `boolean`, `string[]`, `number[]`, `object`, `object[]`,
`any`, each with an optional trailing `?`. A `?` field may be left out of the answer or written as
`null`, and both read as absent; a field without one must be present and must
not be null. Unknown keys are rejected.

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
- `src/skills/inject.ts` — the three notices: unattended, background subagents, file reading
- `src/client/step.ts` — the instruction each executor's node is handed: the prompt, the skill paths, whether it may ask, the memory commands
- `src/client/subagents.ts` — the `claude-code` agents as subagent files under `~/.claude/agents/`, in their own model
- `src/runtime/executors/agent.ts` — the prompt rendered from the node's inputs, and the answer checked against the declared output
- `src/agents/tools.ts` — the tool vocabulary a `gate` agent may name

## Pitfalls

- `tools` is only validated for `executor: gate`, and never enforced. `Read` on a `gate` agent is a save-time error; `read_file` on a `claude-code` agent saves fine and means nothing. A reviewer whose list holds no write tool can still write: the session and the subagent have their own tools.
- A skill declared by an agent must exist in the team's library (own or inherited) or the agent will not save. The shipped `super-*` agents name `superpowers-*` skills; until those are imported, saving one from the editor fails and a run that needs one stops at that node with the reason.
- A skill reaches a node as a path in the copy of the definitions the run pinned when it began. A skill edited on the gate mid-run reaches the next run, not this one.
- An optional input (`?`) renders as an empty string, not as an absent placeholder. A prompt that says "the tester found: {{inputs.tester.failures?}}" reads oddly on the first pass; write the prompt for both cases.
- `model` on an `executor: gate` agent is not the model its node runs on: the session does it in whatever model the person started. Only a `claude-code` agent runs in its own.
- Saving from the dashboard rewrites the file through the form model; a frontmatter key the form does not carry would be lost, which is why the form is data with tests rather than JSX.
- An imported skill edited by hand is marked *edited here* and will be overwritten by a re-import; the only protection is the label.

## Decisions

- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0046 — Every person runs on their own Claude login; gate holds no model credentials and serves no models](../decisions/0046-every-person-runs-on-their-own-claude-login.md)
- [0030 — An optional field may be written as null](../decisions/0030-an-optional-field-may-be-written-as-null.md)
