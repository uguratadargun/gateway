# Workspaces

## Summary

A workflow that declares a workspace gives its agents a real repository to
work in: they read, search, write and run commands inside a checkout made for
that one run, on a branch of its own. The person's own checkout and current
branch are never touched, whatever the agents do — the worst case is a branch
they delete. When the run ends, the branch is what remains: it can be
reviewed with `git diff`, merged, or thrown away.

## How it works

### Declaring one

A workflow without a workspace can plan and review, but it cannot change
anything. Declaring one is a single line:

```yaml
name: Repo dev team
entry: planner
workspace: {}                       # which repository comes from the run
```

`repo` is deliberately not part of the pipeline. A workflow describes how work
is done; the project it is done in is a property of the run. With the
workspace left empty, `repo` becomes a required run input — the run box
pre-fills it, and `/gate:run` defaults it to the directory the person is
standing in, so one pipeline serves every project. A pipeline that only ever
makes sense for one repository pins it:

```yaml
workspace:
  repo: /Users/you/Projects/thing   # optional: pins this pipeline to one repo
  baseRef: main                     # what the run branches from (default HEAD)
  branchPrefix: gate/run            # branch name prefix (default gate/run)
```

An explicit `repo` run input still wins over a pin. On the server, `repo` may
also be the id of a connected repository (`/repos`), which resolves to the
checkout the server manages, with its base ref and its per-worktree
preparation attached. On a developer's machine that id can only mean their
own clone, which they name once with `gate repo <id> <path>`; without it the
run refuses and says so rather than guessing at a directory.

### One worktree per run

Every run gets its own `git worktree` under `~/.gate/workspaces/<executionId>`,
on a branch named `<branchPrefix>-<first eight characters of the execution
id>`, cut from `baseRef`. The worktree is created after the run is registered
and before any node runs, so a workflow that cannot get its workspace fails at
once rather than halfway through a plan. The commit the branch was cut from
is recorded as the run's base commit: the shipped agents commit task by task,
so "what did the run do" is the working tree against that commit, never
against the index — a diff against the index shows a finished run as empty.

A worktree carries only what git tracks, so the checkout's installed
dependencies — `node_modules`, `.venv`, `vendor` — are symlinked in before
the first node. Without this the first agent to run installed them from
scratch, per run, on the developer's own machine (measured at 1.6 GB and a
quarter of an hour for a directory identical to the one next door). A
connected repository's own preparation commands (codegen and the like) run
on the server's worktrees before the first node too; a run on a developer's
machine does not get them, so a pipeline that relies on them wants a
`command` node of its own.

### The branch is the deliverable, not the directory

When a run ends — completed, failed or stopped, on the server or on a
developer's machine — whatever it left uncommitted is committed onto its
branch as `gate: what run <id> left uncommitted when it ended`, the worktree
is removed, and the branch stays. The commit skips hooks (it is a snapshot,
not a change someone is proposing, so a pre-commit lint must not decide
whether it is kept) and leaves the borrowed dependency links out. A branch
with nothing on it past its base goes with its worktree. If the leftovers
cannot be committed, the worktree stays exactly as it is and the run's page
says so. When the run's repository publishes, the branch is pushed at this
moment — the last one at which it exists as a worktree and the first at
which it holds everything — and a push that fails is reported on the run and
changes nothing else.

Worktrees were removed at the end of a run because they were measured at
gigabytes each: a worktree grows its own `node_modules` the moment an agent
installs, and they piled up with every run. Continue checks the worktree out
again from the branch at the same path (or cuts it fresh from the base
commit when the branch went because it held nothing). `gate clean` (or
`/gate:clean`) removes the worktrees runs from before this left behind, the
same way: what each left uncommitted is committed first, the branch is kept
in every case, and a worktree the server has no record of goes only when it
plainly holds nothing that could be lost — fully pushed, or nothing past its
base — unless `--all` says to take it anyway. `--dry-run` lists without
removing.

### Tools

The tools an agent may use are declared per agent, so roles stay honest —
the implementer writes, the reviewers only read. Names are validated when the
agent file is saved, so a typo fails in the editor rather than mid-run.

| tool | what it does |
| --- | --- |
| `read_file` | read a file (line-numbered, optional offset/limit) |
| `list_files` | list the tree, skipping `.git`, `node_modules`, build output |
| `search_files` | regex search across a directory, or within one file |
| `write_file` | create or replace a file |
| `edit_file` | exact-string replace, refusing an ambiguous match |
| `run_command` | run argv in the worktree (no shell string) |

Every path an agent passes is resolved against the worktree and refused if
it escapes it — `../../.ssh/id_rsa`, an absolute path, or a symlink pointing
out of the workspace all fail; listing and searching use `lstat`, so a
symlink is never followed. `run_command` takes an argv array, so nothing the
model writes is ever handed to a shell for interpretation; it can still run
any program, which is what makes `npm test` and everything else work. The
isolation that makes that acceptable is the worktree, not a command filter.
A command has five minutes by default and its output is capped at 30 000
characters; a read is capped at 200 000 bytes, a listing at 500 entries, a
search at 100 matches and 20 000 files. A search does not stop at the
listing's 500: it walks the whole tree until it has its matches, and it
names every limit that hid something — the match cap, the file cap, and each
file over 200 000 bytes it did not read — so "(no matches)" is only ever
said of files that were read.

A tool that fails hands its error back to the model as a tool result, so an
agent can correct itself. There is no tool-round ceiling by default: a fixed
number is generous for a question and nothing at all for an agent working
through a large repository for hours, and the node it kills has already been
paid for. An agent or a run that wants a cap sets one; the node timeout (an
hour when the agent names nothing, `timeoutMs: 0` to turn it off) and the
Stop button are the backstops for a node that is genuinely stuck. A writing
agent that has spent twelve rounds reading without writing anything is
reminded, in the loop, that the worktree is the deliverable, and again every
ten rounds until it starts. Tool calls are recorded on the step and streamed
live, so `/executions/<id>` shows exactly what each agent read, wrote and
ran.

Two more tools, `memory_search` and `memory_feature`, need no worktree and
never write; they are the team's memory and are described in `memory.md`.

### Without a workspace

The same agent files work in a workflow without a workspace: with no
worktree there are no file tools, and the agents fall back to reasoning over
what the workflow hands them. The memory tools are kept. That is the whole
difference between a pipeline with a `workspace` and one without: tools,
and a project's own `npm ci` / `npm test` as real command nodes — a worktree
is a clean checkout, so dependencies are installed once before the loop, and
an install that fails ends the run instead of sending the implementer after
an error it cannot fix.

## Key files

- `src/runtime/workspace.ts` — creating, releasing, restoring and summarising a run's worktree; the leftover commit; the diff against the base commit
- `src/runtime/tools/types.ts` — the tool boundary: an agent only has the tools its file declares, every tool is confined to the run's workspace
- `src/runtime/tools/paths.ts` — path confinement, symlinks resolved and refused
- `src/runtime/tools/workspace-tools.ts` — the six file and command tools and their limits
- `src/runtime/tools/memory-tools.ts` — the two read-only memory tools that need no worktree
- `src/runtime/tools/registry.ts` — the tool vocabulary an agent file may name; prose-only mode without a workspace
- `src/runtime/executors/agent.ts` — the tool loop: no round ceiling by default, the hour-long node timeout, the reconnaissance nudge
- `src/executions/runner.ts` — resolving a run's repository (path or connected id) and preparing the worktree before the first node, on the server
- `src/client/run.ts` — the same on a developer's machine, including `gate repo` for a pinned id
- `src/client/clean.ts` — `gate clean`: which leftover worktrees go, and how

## Pitfalls

- A `git diff` in the worktree against the index shows a finished run as empty, because the shipped agents commit per task. Diff against the base commit (`git diff <base>...<branch>`), which is what the pipeline's own `diff` node and the run page do.
- A workflow pinned to a connected repository id refuses to run on a machine that has not said which clone it means (`gate repo <id> <path>`). It does not guess.
- Connected-repository preparation commands run only on the server. A local run of a pipeline that depends on generated output needs a `command` node for it.
- The leftover commit is made with `--no-verify`; a project whose hooks are the only thing keeping a rule will not have that rule applied to what a run left uncommitted.
- Removing a worktree by hand while its run is going makes the run fail on its next node; the run does not carry on and die later inside some child process.
- `gate reset` keeps worktrees on purpose; `gate clean` is what removes them, and only for runs the server says are over.

## Decisions

- none recorded yet
