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
timeoutMs: 3600000                  # DEFAULT when omitted, and what a new agent should
                                    # carry. Covers the whole node — every tool round,
                                    # not one model call. Raise it for an agent that
                                    # works a large repo; 0 = no timeout at all.
maxTokens: 32000                    # optional; thinking counts against it (default 8192)
maxToolIterations: 0                # optional; 0 (the default) = as many tool rounds as it needs
executor: gate                      # or: claude-code — see Executors below
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
                                # No ceilings unless you ask for them:
maxWorkflowSteps: 0             # 0 = uncapped; a number stops the whole run there
maxVisits: 0                    # 0 = uncapped; a number fails a node that revisits past it
maxCostUsd: 0                   # 0 = uncapped. THIS is the ceiling worth setting: how
                                # many rounds a task needs cannot be known up front,
                                # what you will pay for it can. Checked between nodes,
                                # cumulative across a Continue.
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
    timeoutMs: 3600000          # DEFAULT when omitted — same hour an agent gets.
                                # A test suite that runs longer needs a bigger
                                # number here, or 0 for no timeout at all.
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
`outputs.<id>.ok`, and feed **both** `outputs.<id>.stdout` and
`outputs.<id>.stderr` to the agent that must fix it. Test runners split their
output across the two and which half carries the failure is not yours to guess;
an implementer handed only `stdout` can be told a run failed with nothing that
says why.

A command node's `command` is an argv array run with no shell, which means no
pipes, no `&&`, no globbing and no `$VAR`. It also means the interpreter is
found on `PATH`: write `[node, ...]`, `[python3, ...]`, `[npm, test]` — never an
absolute path into a version manager like `~/.nvm/versions/node/v22.21.1/bin/node`,
which pins the pipeline to one installed version and breaks on the next upgrade.

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

That is also why a reviewer is **handed** the diff rather than left to find it:
without `run_command` it cannot run `git diff`, and with only a list of changed
paths it reads each file's current state with no way to tell which lines are
new. See the diff node in the shape below — it is not optional.

## Executors — who runs the loop inside a node

`executor: gate` (the default) means gate holds the conversation and serves the
six tools above. `executor: claude-code` hands the node to a headless Claude
Code running in the worktree instead.

|  | `gate` | `claude-code` |
| --- | --- | --- |
| tools | the six above, with hard caps: 200KB reads, search stops at 100 matches, 30KB of command output | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `TodoWrite`… — real ripgrep, ranged reads, uniqueness-checked edits |
| context | every tool result appended, never trimmed | compacted by the harness |
| `tools:` names | `read_file`, `edit_file`, … | `Read`, `Edit`, `Grep`, … |

The context row is the one that decides it. A node that reads its way through a
large repository on the gate loop ends up re-sending a six-figure context every
round: a planner measured here spent $7 and 9M tokens without answering, most of
it re-reading itself. No round cap fixes that — a cap kills the node; compaction
lets it finish. Reach for `claude-code` on any node that explores or edits a real
repository, and leave short deterministic nodes on `gate`, which starts instantly
where the harness pays about 50-70K tokens of system prompt to start at all.

Routing, metering and `maxCostUsd` are unaffected: the child is pointed at this
gate's own gateway, so every call it makes is routed and counted exactly like one
gate made itself. It needs a `workspace` — the worktree is what it runs in — and it runs
unattended with `--permission-mode bypassPermissions`, the
`--dangerously-skip-permissions` setting: an implementer that must run the
project's own toolchain cannot have its commands enumerated in advance, and a
denied call in an unattended run surfaces as a mysterious failure an hour later.
Know what that buys and costs — the worktree is a throwaway branch, but Bash is
not confined to it, so a node is bounded by the machine gate runs on.

## Shape that works

```
setup ─▶ planner ─▶ implementer ─▶ stage ─▶ diff ─▶ tests ─┬─ pass ─▶ reviews ─┬─ reviewer ─┐
           ▲                                     ▲         │                   └─ security ─┴─▶ verdict
           │                                     └── fail ──┘                                     │
           └──────────────── changes requested ───────────────────────────────────────────────────┘
```

Plan → implement → take the diff → run the project's real test command → review
in parallel → a condition that either finishes or sends the work back.

Three things in that picture are easy to get wrong, and each one is a rule.

### The diff comes from git, never from the implementer

Do not give the implementer an output field like `diff: string`. Making a model
retype a diff it has already written to disk burns its whole output budget, can
truncate, and can drift from what is actually in the worktree — the reviewers
then review a description of the change instead of the change.

Two command nodes between the implementer and the tests, because `command` is
argv with no shell:

```yaml
  - id: stage
    type: command
    label: Stage new files            # `add -N` so new files appear in the diff
    command: [git, add, -N, .]
    next: diff

  - id: diff
    type: command
    label: git diff
    command: [git, diff]
    edges:
      - when: outputs.diff.stdout != ""
        to: tests
        label: has changes
      - to: nothing-changed           # a terminal with status: failed
        label: worktree unchanged
```

Every reviewer then declares `inputs: [diff.stdout, …]` and reads
`{{inputs.diff.stdout}}`. The empty-diff edge matters too: an implementer that
wrote nothing must fail the run, not hand the reviewers a blank page to approve.

### Rejection goes back to the planner, not the implementer

A failing test goes back to the **implementer** — the plan was fine, the code
was not. A rejected review goes back to the **planner**, and the planner then
hands a revised plan down.

The reason is that a review rejection is very often "this was cut at the wrong
seam", and the implementer cannot act on that: it is holding a plan that says
to do exactly what was just rejected, so it produces the same shape again and
the loop spins until the budget stops it. Give the planner the optional inputs
that let it revise:

```yaml
inputs: [reviewer.findings?, security.findings?, implementer.summary?]
```

They are empty on the first pass, which is how one planner file serves both.

### Every output a node declares must be read by something

An agent that returns `risks` nobody consumes is paying for tokens that go
nowhere. Before saving, trace each field of each agent's `output.schema` to the
`inputs:` list that reads it, and delete the ones with no reader.

## Before you save — check every one of these

A definition that fails any of these is wrong even though the server will
accept it. The server validates shape, not sense.

- [ ] **Every agent carries `timeoutMs: 3600000`** — explicitly, all of them, the
      implementer included. Not `0`, which means no timeout at all and lets a
      wedged node hang the run until someone notices it. Raise it for an agent
      you expect to run longer; never lower it below the hour without a reason.
- [ ] **`maxCostUsd` is set** to something the user would actually pay for one
      run. It is the only ceiling that bounds an uncapped pipeline.
- [ ] **`maxWorkflowSteps: 0` and `maxVisits: 0`** unless the user asked for a
      cap. Rounds and revisits cannot be counted in advance; spend can.
- [ ] **A `stage` + `diff` node pair exists**, and every reviewer takes
      `diff.stdout` — not `changed_files`, not a `diff` field from the model.
- [ ] **The empty-diff edge exists** and lands on a `status: failed` terminal.
- [ ] **Review rejection routes to the planner**, test failure to the implementer.
- [ ] **The planner declares the optional review inputs** so a second pass can
      revise the plan.
- [ ] **Command nodes that can fail feed both `stdout` and `stderr`** to whoever
      must fix them.
- [ ] **No absolute interpreter paths** in any `command` — `PATH` resolves them.
- [ ] **No orphan output fields** — every one is read somewhere.
- [ ] **Every command you wrote is a command this repository really has**, taken
      from `package.json` / `Makefile` / CI, not invented.
