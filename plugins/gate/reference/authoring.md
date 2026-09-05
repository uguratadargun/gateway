# Writing gate agents and workflows

Two file kinds. Both are saved through the CLI, which posts them to the running
gate server; the server parses and validates before anything is written, so a
rejected save means the definition is wrong, not that the save failed. Fix what
the error says and save again.

## Agent — Markdown, YAML frontmatter + prompt body

```markdown
---
name: Planner                       # required, ≤64 chars
description: One line.              # optional, ≤500
model: sonnet                       # tier alias (haiku/sonnet/opus) or a claude-* id
effort: high                        # default | low | medium | high | xhigh | max
inputs: [planner.plan, tests.stdout?]   # upstream node outputs this agent may read
tools: [read_file, list_files]      # see Tools
output:
  type: json                        # or: type: text
  schema:
    verdict: string                 # string, number, boolean, string[], number[], object, any
    findings: "string[]"            #   a trailing "?" makes the field optional
    notes: "string?"
timeoutMs: 120000                   # optional, 1s–10min
maxTokens: 32000                    # optional; thinking counts against it (default 8192)
---

Prompt text. Two placeholder forms, and nothing else — no expressions, no code:

  {{input.task}}                    the run's input, by key
  {{inputs.planner.plan}}           an upstream node's output field

Say what JSON you want back, field by field.
```

Rules that reject a save:

- Every `{{inputs.x}}` must appear in `inputs:`. `{{input.*}}` is the run input
  and is not declared.
- An input marked `foo.bar?` is optional at run time; the `?` is not part of the
  path a placeholder uses.
- `inputs:` entries are `<nodeId>.<field>` — the *node* id in the workflow, which
  is not always the agent id.
- The file name is the agent id: lowercase letters, digits and dashes.

## Workflow — YAML

```yaml
name: Repo dev team
description: One line.
entry: planner                  # node the run starts at
workspace: {}                   # this pipeline works in a git worktree of the
                                # repo given as the run's "repo" input.
                                # add `repo: /path` to pin one project instead.
                                # omit `workspace` entirely for a prose-only
                                # pipeline — then agents get NO tools.
maxWorkflowSteps: 60            # ceiling on total steps
maxVisits: 5                    # ceiling per node; a loop that exceeds it fails
nodes:
  - id: planner
    type: agent
    agent: planner              # an agent id that must already exist
    label: Plan
    next: implementation

  - id: tests                   # deterministic: routing on an exit code, not an opinion
    type: command
    label: npm test
    command: [npm, test]        # argv array, no shell
    cwd: packages/core          # optional, relative to the worktree
    timeoutMs: 600000           # optional
    edges:
      - when: outputs.tests.ok == true
        to: checks
        label: tests pass
      - to: implementation      # fallback edge: no `when`
        label: tests failed

  - id: checks
    type: parallel              # branches run concurrently and meet at `join`
    label: Reviews
    branches: [reviewer, security]
    join: verdict

  - id: reviewer
    type: agent
    agent: reviewer
    next: verdict

  - id: security
    type: agent
    agent: security-reviewer
    next: verdict

  - id: verdict
    type: condition             # routing only, produces no output
    label: Both approved?
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
        label: approved
      - to: implementation
        label: changes requested

  - id: done
    type: terminal              # ends the run
    status: completed           # or: failed
```

Rules that reject a save:

- `entry` must exist; at least one `terminal` node; every node reachable from
  `entry`.
- Use `next:` **or** `edges:`, never both. Every non-terminal, non-parallel node
  needs at least one outgoing edge, and at most one edge without a `when`.
- A `condition` node needs at least one edge with a `when`.
- A `parallel` node's branches must be disjoint, must each reach the `join`, must
  not contain a terminal, and nothing outside may point into one.
- Conditions read only `outputs.<nodeId>.<field>` and `input.<key>`, and the node
  id must exist.
- Node ids and the workflow id are lowercase letters, digits and dashes.

### Condition language

Comparisons `== != > >= < <=`, boolean `&& || !`, parentheses, string/number/
boolean literals. Nothing else — it is parsed and interpreted, never evaluated
as code.

```
outputs.tester.passed == true
outputs.tests.ok == false && outputs.reviewer.verdict != "approved"
input.mode == "strict"
```

### Command node output

A `command` node's output is `{ ok, exitCode, stdout, stderr }` — route on
`outputs.<id>.ok`, and feed `outputs.<id>.stdout` to the agent that must fix it.

## Tools

Only available when the workflow declares a `workspace`; without one the same
agent file still runs, with no tools, reasoning over what it is handed.

| tool | what it does |
| --- | --- |
| `read_file` | read a file in the worktree |
| `list_files` | list a directory |
| `search_files` | search the worktree |
| `write_file` | write a file |
| `edit_file` | replace a string in a file |
| `run_command` | run an argv command in the worktree |

Give writing tools only to the agent that implements. A reviewer gets
`read_file`, `list_files`, `search_files` and nothing more — a reviewer that can
edit is not a reviewer.

## Shape that works

Plan → implement → run the project's real test command → review (in parallel
with a security review) → a condition that either finishes or routes back to
implementation. Failure and rejection both go back to the implementer, and
`maxVisits` stops it looping forever.
