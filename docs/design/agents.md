# Agents

## Summary

An agent is one role in a pipeline — planner, implementer, reviewer — written
as a Markdown file a person can read and edit: a few lines of frontmatter say
how it runs, and the body is its prompt. The prompt carries the agent's whole
method; nothing outside it tells the agent how to work. Agents belong to a
team and are validated when saved, so a broken definition fails in the editor
rather than an hour into a run.

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
`claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-4-5-20251001`.

`executor` says who does the node in a run the person's session drives. `gate` is the session itself, with
its own tools and its own model, in front of the person: `model` and `effort`
name nothing that runs there. `claude-code` is always a subagent of the session,
in the agent's own `model` and `effort`, started from the file gate keeps for the agent
under `~/.claude/agents/` (`gate-<team>-<agent>`), with a context of its own.
That file is the only thing that reaches Claude Code, so it carries both; an
agent with no `effort`, or `default`, leaves the line out and the subagent
thinks as hard as the session does. Which model an alias means is the
person's Claude Code's business: it resolves `opus` to the session's own model
when the session is already an Opus, and a person can repoint an alias on
their machine (`ANTHROPIC_DEFAULT_OPUS_MODEL` and its siblings) without gate
knowing.
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

A `claude-code` node is also told three things about where it runs, beside
whatever its own prompt says. A subagent cannot reach the person, so the node
is told it runs **unattended**: nothing it asks can be answered, and what to
do instead. It
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
gets none of them: the person is right there, and a node that needs to ask
should ask. The invariant is about the sites, not the count: a notice added to one
agent's prompt instead reaches only that agent, and `tests/notices.test.ts` is
what says the subagent file carries its two.

Team scoping: a team's own copy of a name wins, anything it has not written
it inherits from the default team's library, and nothing can write into the
fallback — so a team can replace `planner` with its own without asking anyone
and without affecting anyone. The default team's directories are seeded with the shipped agents the
first time `/agents` or `/workflows` is opened, only when the directory does
not exist yet, so deleting a shipped agent sticks; a team you create starts
empty. A refresh writes back the shipped text of any agent that has drifted,
keeps the `model` and `effort` set on it, and puts the old text under
`<team>/backups/<stamp>/agents/`. It moves an agent gate no longer ships (the
`super-*` four) to the same place, after the pipelines that named it.

## File format

```markdown
---
name: Tester
model: sonnet          # haiku | sonnet | opus | fable, or a concrete claude-* id
effort: medium         # optional: low | medium | high | xhigh | max
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
(`question` | `approval`; `person` is read as `question`), `tools`,
`timeoutMs` (how long one visit to the node is expected to take; past it the
person is told the node is overrunning, and stopping it is theirs; default one
hour, `0` for no notice), and `maxTokens`, `maxToolIterations` and `skills`
(accepted, so an older agent file keeps loading, and read by nothing; a save
from the editor drops `skills`). Output field types are
`string`, `number`, `boolean`, `string[]`, `number[]`, `object`, `object[]`,
`any`, each with an optional trailing `?`. A `?` field may be left out of the answer or written as
`null`, and both read as absent; a field without one must be present and must
not be null. Unknown keys are rejected.

## Key files

- `src/agents/types.ts` — the frontmatter schema, output field types, `buildOutputSchema`
- `src/agents/loader.ts` — parsing and validation of an agent file; undeclared-input and unknown-tool checks
- `src/agents/template.ts` — `{{ path }}` substitution with no evaluation
- `src/agents/registry.ts` — the file store per scope, with fallback to the default team
- `src/agents/defaults.ts` — the shipped agents, seeding, refresh with tuning kept
- `src/agents/form.ts`, `src/agents/new-agent-template.ts` — the editor's form model and the starting file
- `src/client/notices.ts` — the three notices: unattended, background subagents, file reading
- `src/client/step.ts` — the instruction each executor's node is handed: the prompt, whether it may ask, the memory commands
- `src/client/subagents.ts` — the `claude-code` agents as subagent files under `~/.claude/agents/`, in their own model
- `src/runtime/executors/agent.ts` — the prompt rendered from the node's inputs, and the answer checked against the declared output
- `src/agents/tools.ts` — the tool vocabulary a `gate` agent may name

## Pitfalls

- `tools` is only validated for `executor: gate`, and never enforced. `Read` on a `gate` agent is a save-time error; `read_file` on a `claude-code` agent saves fine and means nothing. A reviewer whose list holds no write tool can still write: the session and the subagent have their own tools.
- An agent file that still names `skills` loads and runs, and nothing tells its node about them. A prompt written to lean on a skill ("follow your brainstorming skill") now leans on nothing; the method has to be in the prompt.
- An optional input (`?`) renders as an empty string, not as an absent placeholder. A prompt that says "the tester found: {{inputs.tester.failures?}}" reads oddly on the first pass; write the prompt for both cases.
- `model` on an `executor: gate` agent is not the model its node runs on: the session does it in whatever model the person started. Only a `claude-code` agent runs in its own.
- Saving from the dashboard rewrites the file through the form model; a frontmatter key the form does not carry would be lost, which is why the form is data with tests rather than JSX.

## Decisions

- [0063 — Agents follow no skills, and dev-super is gone](../decisions/0063-agents-follow-no-skills.md)
- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0046 — Every person runs on their own Claude login; gate holds no model credentials and serves no models](../decisions/0046-every-person-runs-on-their-own-claude-login.md)
- [0030 — An optional field may be written as null](../decisions/0030-an-optional-field-may-be-written-as-null.md)
