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
skills: [superpowers-brainstorming] # optional; processes this agent follows — see Skills
output:
  type: json                        # or: type: text
  schema:
    verdict: string                 # string, number, boolean, string[], number[], object, object[], any
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
- Every entry in `skills:` must be a skill the team's library can resolve — its
  own or one it inherits. A name that does not resolve is refused on save, with
  the list of the ones that do.

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
- Conditions read only `outputs.<nodeId>.<field>`, `input.<key>` and
  `visits.<nodeId>`, and the node id must exist.
- Node ids and the workflow id are lowercase letters, digits and dashes.
- A `disabled` node needs a way past it: one edge, or a `skipTo` naming one of
  its own edges. Switched-off nodes may not skip in a circle.

### Switching a step off

`disabled: true` takes a step out of the run without taking it out of the
graph. Nothing is called, nothing is spent, no step is recorded and no visit is
counted — `visits.<id>` counts what ran — and the run carries on along one of
the node's own edges:

```yaml
  - id: security
    type: agent
    agent: security-reviewer
    disabled: true              # off: runs walk straight past it
    skipTo: verdict             # which of its edges they take
    edges:
      - when: outputs.security.verdict == "approved"
        to: verdict
      - to: implementation
```

`skipTo` is only needed when the node has more than one edge, and it must name
one of them: turning a step off changes what a run does, never where its graph
can go. A node with a single `next:` needs nothing else.

Only `agent` and `command` nodes can be switched off. `condition` and
`parallel` are routing — a routing node that routes nowhere is a broken graph,
not a paused one — and `terminal` is the end of the run.

What this does **not** do is fill in for the node. A later node that reads
`outputs.security.verdict` as a required input fails on it, exactly as it would
before that node had ever run; make the input optional (`outputs.security.verdict?`)
if it has to survive the step being off. On the canvas the node stays where it
is, dimmed and marked `off`, and the inspector's **Turn off** / **Turn on**
button is what writes these two fields.

### Condition language

Comparisons `== != > >= < <=`, boolean `&& || !`, parentheses, string/number/
boolean literals. Nothing else — it is parsed and interpreted, never evaluated
as code.

```
outputs.tester.passed == true
outputs.tests.ok == false && outputs.reviewer.verdict != "approved"
input.mode == "strict"
visits.tests >= 5
```

`visits.<nodeId>` is how many times that node has run so far in this run,
counting the attempt in progress — so a node reads its own visit as 1 the first
time it runs. A node that has not run yet is 0, never absent, so an edge written
to end a loop is simply false on the first pass. An agent can declare it as an
input too (`inputs: [visits.implementer]`, read as `{{inputs.visits.implementer}}`)
to be told which attempt it is on.

### Command node output

A `command` node's output is `{ ok, exitCode, stdout, stderr }` — route on
`outputs.<id>.ok`, and feed **both** `outputs.<id>.stdout` and
`outputs.<id>.stderr` to the agent that must fix it. Test runners split their
output across the two and which half carries the failure is not yours to guess;
an implementer handed only `stdout` can be told a run failed with nothing that
says why.

Each argument may carry `{{outputs.<id>.<field>}}`, `{{input.<key>}}` and
`{{visits.<id>}}`, rendered per argument and never re-split — so a commit
message full of spaces and newlines stays one argv entry. That is what lets a
pipeline commit with the implementer's own summary instead of reaching for an
agent to run `git`, which is a model doing a deterministic job. A reference to
something never produced fails the node.

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
| tools | the six above, with hard caps: 200KB reads, search stops at 100 matches, 30KB of command output | the whole Claude Code toolset — real ripgrep, ranged reads, uniqueness-checked edits, `Bash`, `TodoWrite` |
| context | every tool result appended, never trimmed | compacted by the harness |
| `tools:` | the allowlist, and it is enforced | **ignored** — see below |

The context row is the one that decides it. A node that reads its way through a
large repository on the gate loop ends up re-sending a six-figure context every
round: a planner measured here spent $7 and 9M tokens without answering, most of
it re-reading itself. No round cap fixes that — a cap kills the node; compaction
lets it finish. Reach for `claude-code` on any node that explores or edits a real
repository, and leave short deterministic nodes on `gate`, which starts instantly
where the harness pays about 50-70K tokens of system prompt to start at all.

`tools:` is not enforced for a `claude-code` agent. `--allowed-tools` gates
permission *prompts*, not capability, and under the permission mode below
there are no prompts — measured here: a child given `--allowed-tools Read`
reached for `Bash` on its first move and was not stopped. A node that must work
a real repository gets the real toolset; that is the trade being made. The list
still means something: a run driven from a session (`/gate:run`) reads it as
the shape of the role and stays inside it, which is why the shipped agents
carry one. Write it as the shape of the job — reads for a reviewer, writes for
an implementer — and know that headless it is a description, not a fence.

Every tool call it makes is streamed back (`--output-format stream-json`) and
becomes a `tool.called` event, so a claude-code node is watchable on the
executions page while it runs, not only once it is over.

Routing, metering and `maxCostUsd` are unaffected: the child is pointed at this
gate's own gateway, so every call it makes is routed and counted exactly like one
gate made itself. It needs a `workspace` — the worktree is what it runs in — and it runs
unattended with `--permission-mode bypassPermissions`, the
`--dangerously-skip-permissions` setting: an implementer that must run the
project's own toolchain cannot have its commands enumerated in advance, and a
denied call in an unattended run surfaces as a mysterious failure an hour later.
Know what that buys and costs — the worktree is a throwaway branch, but Bash is
not confined to it, so a node is bounded by the machine gate runs on.

## Skills — the process an agent follows

`tools:` says what an agent may touch. `skills:` says how it works: each entry
names a `SKILL.md` in the team's library, and an agent that declares one is told
to follow it on every run rather than being left to notice it might apply.

|  | `gate` | `claude-code` |
| --- | --- | --- |
| how it arrives | the skill's prose folded into the system prompt | a generated plugin, loaded as `gate-skills:<id>` |
| the files a skill ships | named, and marked unreadable — gate's tools cannot leave the worktree | there, beside the skill, as written |
| cost | the whole text, every round | the harness opens it when it is due |

So a skill that is mostly prose works on either executor, and a skill that leans
on scripts or reference files beside it belongs on a `claude-code` agent.

Import skills on the dashboard's Skills page — `superpowers` ships registered,
one Sync away, under the `superpowers-` prefix. Assign them in the agent editor,
or write the `skills:` line by hand.

Use one when the node has a *method* worth naming, not as decoration: a planner
that should interrogate the request before designing takes
`superpowers-brainstorming`; an implementer that must write the test first takes
`superpowers-test-driven-development`. An agent carrying five skills is an agent
whose prompt no longer decides anything.

Read the skill before binding it, because a skill was written for a session
with a person in it and a pipeline node often has none. Three things the
`superpowers` skills do that a prompt has to answer for:

- **They stop for a human.** Brainstorming will not proceed past its approval
  gate; executing plans raises concerns "before starting". Headless, nobody
  answers — the prompt has to say what to do instead (rule, and record the
  ruling), or the node ends on a question.
- **They commit as they go.** Writing plans puts a commit step in every task;
  subagent-driven development commits after each one. A pipeline that then
  runs a plain `git diff` sees nothing. Diff against the run's base commit
  (see the shape below), and let the commit node find nothing to commit.
- **They hand off to skills the team may not hold.** Executing plans and
  subagent-driven development end in `finishing-a-development-branch`, which
  asks what to do with the branch. The pipeline already knows; tell the agent
  where its skill's process stops.

## Shape that works

gate ships this as `dev`, using the team's `planner`, `implementer` and
`reviewer`:

```
base ─▶ planner ─▶ implementer ─┬─ changed: false ─▶ nothing-changed
          ▲                     └─▶ stage ─▶ diff ─┬─ empty ─▶ nothing-changed
          │                                        └─▶ reviewer ─▶ verdict ─┬─ approved ─▶ stage-all ─▶ staged ─┬─ nothing left ─▶ merge-request ─▶ done
          │                                                                 ├─ 4th plan rejected ─▶ review-stuck  └─▶ commit ─────▶ merge-request ─▶ done
          └──────────────────────── changes requested ──────────────────────┘
```

`base` records the commit the run started from, `diff` is the working tree
against it, and the reviewer is handed both — because the agents' skills
commit as they go and a diff against the index would be empty. The planner
writes a plan *file* (`planFile`) and the implementer executes that file: the
implementer's skills take a plan file, not a list of steps in a prompt.

It contains no `npm ci` and no `npm test` on purpose: those are facts about one
project, and a default that assumes them fails on the first machine it meets.
What a particular repository needs goes around it — install and codegen before
the planner, its real test command between the implementer and the review, and
a merge-request node that matches its host. `/gate:design` writes those, reading
them out of the repository rather than guessing.

The shipped agents follow skills (brainstorming, using git worktrees and
writing plans for the planner; executing plans, test-driven development and
subagent-driven development for the implementer; requesting code review for
the reviewer), which is what makes them a team rather than three prompts. Name
them; do not copy them into project-specific variants.

Three things in that picture are easy to get wrong, and each one is a rule.

### The diff comes from git, never from the implementer

Do not give the implementer an output field like `diff: string`. Making a model
retype a diff it has already written to disk burns its whole output budget, can
truncate, and can drift from what is actually in the worktree — the reviewers
then review a description of the change instead of the change.

Three command nodes, because `command` is argv with no shell — one at the
entry, two after the implementer:

```yaml
  - id: base                          # the entry: before anything can commit
    type: command
    label: Record the starting commit
    command: [git, log, "-1", --format=format:%H]   # format: prints no newline
    next: planner

  - id: stage
    type: command
    label: Stage new files            # `add -N` so new files appear in the diff
    command: [git, add, -N, .]
    next: diff

  - id: diff
    type: command
    label: Diff against the starting commit
    command: [git, diff, "{{outputs.base.stdout}}"]
    edges:
      - when: outputs.diff.stdout != ""
        to: tests
        label: has changes
      - to: nothing-changed           # a terminal with status: failed
        label: worktree unchanged
```

Against the base commit, not a bare `git diff`: the implementer's skills commit
task by task, and the working tree against the index is then empty however
much was built. `git diff <base>` is everything the run did, committed or not.

Every reviewer then declares `inputs: [base.stdout, diff.stdout, …]` and reads
`{{inputs.diff.stdout}}` — and a reviewer whose skill wants a git range gets
the base from `{{inputs.base.stdout}}`, with the working tree as its head. The
empty-diff edge matters too: an implementer that wrote nothing must fail the
run, not hand the reviewers a blank page to approve.

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

### A stale output is still an output

A node's output stays in the run's state for the rest of the run. `outputs.tests`
does not empty when the tests pass — it holds the *last* test run, green or red,
and every later visit to the implementer reads it.

So an agent handed a command node's output must be told when it is relevant, or
it will read a passing suite as a failure and go hunting for it. Route on `ok`
and hand `ok` over with the text:

```yaml
inputs: [tests.ok?, tests.stdout?, tests.stderr?]
```

```
The suite exited with ok = {{inputs.tests.ok}}. Fixing it is this pass's job
only when that is false; when it is true the report below is the last green run
and there is nothing in it for you.
```

The same applies to a review's findings after the review has been re-run, and to
anything else a loop can reach twice. "Empty on the first pass" is true exactly
once; it is not true on the fourth.

### A retry loop needs an end

`tests fail → implementer → tests` is the right shape, but on its own it has no
end: an implementer that cannot fix a failure produces the same failure forever,
and the `nothing-changed` edge cannot catch it — after the first pass `git diff`
is non-empty whether or not this visit changed anything.

`maxVisits` is the engine's ceiling and it fails the whole run with "node ran N
times". A pipeline that knows how many attempts a fix is worth should say so
itself and land somewhere that reports what is stuck:

```yaml
  - id: tests
    type: command
    command: [npm, test]
    edges:
      - when: outputs.tests.ok == true
        to: reviews
        label: tests pass
      - when: visits.tests >= 6
        to: tests-stuck
        label: still red after 6 runs
      - to: implementer
        label: tests failed

  - id: tests-stuck
    type: terminal
    label: Tests never went green
    status: failed
```

Order matters: edges are tried in declaration order and the first match wins, so
the give-up edge goes after the success edge and before the loop-back fallback.
Give the same treatment to the review-rejection loop (`visits.planner >= 4`).

### Approved work has to ship

A pipeline that ends at `done` the moment both reviewers approve leaves the
change sitting uncommitted in a worktree nobody will look at. Approval is not
delivery. Finish the graph with real command nodes:

```yaml
  - id: stage-all
    type: command
    label: Stage everything
    command: [git, add, -A]          # add -N staged intent only; commit needs the content
    next: staged

  - id: staged                       # the skills may have committed everything already
    type: command
    label: Anything left to commit?
    command: [git, diff, --cached, --quiet]   # exits 0 when there is nothing
    edges:
      - when: outputs.staged.ok == true
        to: push
        label: already committed
      - to: commit
        label: has staged changes

  - id: commit
    type: command
    label: Commit
    # Two -m: the task is the subject, the implementer's own summary is the body.
    command: [git, commit, -m, "{{input.task}}", -m, "{{outputs.implementer.summary}}"]
    edges:
      - when: outputs.commit.ok == true
        to: push
      - to: not-shipped

  - id: push
    type: command
    label: Push and open the merge request
    # GitLab push options: no API token, because the SSH key that cloned the
    # repository is already the whole authentication story. GitHub's equivalent
    # is a [gh, pr, create, ...] node after a plain push.
    command:
      - git
      - push
      - -o
      - merge_request.create
      - -o
      - merge_request.target=main
      - -o
      - "merge_request.title={{input.task}}"
      - --set-upstream
      - origin
      - HEAD
    edges:
      - when: outputs.push.ok == true
        to: done
      - to: not-shipped
        label: approved but not pushed

  - id: not-shipped
    type: terminal
    label: Approved but not delivered
    status: failed
```

The failed-push terminal is the point: "approved but not delivered" must not be
reported as done. Check the repository's real default branch (`git symbolic-ref
refs/remotes/origin/HEAD`) rather than assuming `main`.

### A worktree does not carry generated files

Each run works in a fresh `git worktree`, so it contains what git tracks and
nothing else. Build output — a protobuf bundle, transpiled `.js` beside the
`.ts`, generated clients, compiled assets — is normally gitignored, which means
it is **not there**, however complete the main checkout looks.

Measured here: a repository whose main checkout had 924 generated `.js` files
under `ts/` gave a worktree 2 of them. Nineteen test files failed on
`Cannot find module`, every pass, byte-identical — a failure no implementer can
fix, because it is not in the code, and the loop ran until the budget stopped it.

So find the generation step and put it between the workspace setup and the
planner, one `command` node per script (argv has no `&&`):

```yaml
  - id: protobuf
    type: command
    command: [pnpm, build-protobuf]
    next: transpile

  - id: transpile
    type: command
    command: [pnpm, transpileNew]
    next: planner
```

**Verify the test command inside a worktree, not in the main checkout.** Running
it where the artifacts already exist proves nothing about where the node runs —
that is exactly how this was missed.

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
- [ ] **A `base` node is the entry, and a `stage` + `diff` pair diffs against
      it** (`git diff {{outputs.base.stdout}}`); every reviewer takes
      `base.stdout` and `diff.stdout` — not `changed_files`, not a `diff`
      field from the model, not a bare `git diff` that is empty once the
      implementer's skills have committed.
- [ ] **The empty-diff edge exists** and lands on a `status: failed` terminal.
- [ ] **Review rejection routes to the planner**, test failure to the implementer.
- [ ] **The planner declares the optional review inputs** so a second pass can
      revise the plan.
- [ ] **Command nodes that can fail feed both `stdout` and `stderr`** to whoever
      must fix them, **and `ok` alongside them** — an output outlives the pass
      that produced it, so an agent that is not told `ok` reads the last green
      run as a failure.
- [ ] **Every loop-back edge has a give-up edge**, `visits.<node> >= n`, declared
      after the success edge and before the fallback, landing on a `status:
      failed` terminal that names what is stuck.
- [ ] **If the run is meant to deliver, the pipeline ships what it approved** —
      stage, commit with `{{outputs.<implementer>.summary}}` when anything is
      left to commit, push — and a failed push lands on its own `status: failed`
      terminal. Ending at `done` on
      approval leaves the change in a worktree nobody opens; that is a choice to
      make deliberately, not by omission.
- [ ] **No absolute interpreter paths** in any `command` — `PATH` resolves them.
- [ ] **No orphan output fields** — every one is read somewhere.
- [ ] **Every skill in `skills:` is in the team's library** — a name that does
      not resolve is refused on save, and a skill leaning on its own files
      belongs on a `claude-code` agent, where those files exist.
- [ ] **Every skill's prompt answers for what the skill does unattended** —
      where it would wait for a person, where it commits, and which skill it
      hands off to that the team does not hold. See Skills above.
- [ ] **`tools:` on a `claude-code` agent is the role's shape, not a fence** —
      a session-driven run stays inside it, a headless one does not. Reads for
      a reviewer, writes for an implementer, and nothing that relies on it.
- [ ] **Every command you wrote is a command this repository really has**, taken
      from `package.json` / `Makefile` / CI, not invented.
- [ ] **The generation step runs before the planner** if anything the tests need
      is gitignored build output — established by listing the repository's
      ignored artifacts, not by assuming there are none.
- [ ] **The test command was verified inside a worktree**, not in the main
      checkout where the build output already exists.
- [ ] **A list-of-things output field is `object[]`, not `string[]`**, unless the
      prompt genuinely wants one line each. A reviewer asked for `findings`
      returns objects; declaring `string[]` makes every run spend a correction
      round arguing with it.
