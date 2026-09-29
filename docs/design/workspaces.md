# Workspaces

## Summary

A workflow that declares a workspace gives its agents a real repository to
work in: they read, search, write and run commands inside a checkout made for
that one run, on a branch of its own, on the person's own machine. The
person's own checkout and current branch are never touched, whatever the
agents do — the worst case is a branch they delete. When the run ends, the
branch is what remains: it can be reviewed with `git diff`, merged, or thrown
away.

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
workspace left empty, `repo` becomes a required run input, and `/gate:run`
defaults it to the repository the person is standing in, so one pipeline
serves every project. A pipeline that only ever makes sense for one
repository pins it:

```yaml
workspace:
  repo: /Users/you/Projects/thing   # optional: pins this pipeline to one repo
  baseRef: main                     # what the run branches from (default HEAD)
  branchPrefix: gate/run            # branch name prefix (default gate/run)
```

An explicit `repo` run input still wins over a pin. `repo` may also be the
id of a repository connected on the gate (`/repos`). On a person's machine
that id can only mean their own clone, which they name once with `gate repo
<id> <path>`; without it the run refuses and says so rather than guessing at
a directory.

### One worktree per run

Every run gets its own `git worktree` under `~/.gate/workspaces/<executionId>`
on the machine that drives it, on a branch named `<branchPrefix>-<first
eight characters of the execution id>`, cut from `baseRef`. `gate begin`
creates it after the run is registered and before any node runs, so a
workflow that cannot get its workspace fails at once rather than halfway
through a plan, and reports it to the gate so the dashboard shows the branch
while the run is going. Nothing on the server cuts worktrees for runs. The
commit the branch was cut from is recorded as the run's base commit: the
shipped agents commit task by task, so "what did the run do" is the working
tree against that commit, never against the index — a diff against the
index shows a finished run as empty.

A worktree carries only what git tracks, so the checkout's installed
dependencies — `node_modules`, `.venv`, `vendor` — are symlinked in before
the first node. Without this the first agent to run installed them from
scratch, per run, on the developer's own machine (measured at 1.6 GB and a
quarter of an hour for a directory identical to the one next door). A
pipeline that needs generated output (codegen and the like) wants a
`command` node of its own for it. A connected repository's `setup` commands
run once in the gate's own checkout of it, not in a run's worktree.

### The branch is the deliverable, not the directory

When a run ends — completed, failed or stopped — whatever it left
uncommitted is committed onto its branch as `gate: what run <id> left
uncommitted when it ended`, the worktree is removed, and the branch stays. A
run stopped from the dashboard ends this way on its session's next `gate`
call. The commit skips hooks (it is a snapshot, not a change someone is
proposing, so a pre-commit lint must not decide whether it is kept) and
leaves the borrowed dependency links out. A branch with nothing on it past
its base goes with its worktree. If the leftovers cannot be committed, the
worktree stays exactly as it is and the run's page says so. When the run's
repository publishes, the branch is pushed at this moment — the last one at
which it exists as a worktree and the first at which it holds everything —
and a push that fails is reported on the run and changes nothing else.

Worktrees are removed at the end of a run because they were measured at
gigabytes each: a worktree grows its own `node_modules` the moment an agent
installs, and they piled up with every run. `gate continue` checks the
worktree out again from the branch at the same path (or cuts it fresh from
the base commit when the branch went because it held nothing). `gate clean`
(or `/gate:clean`) removes the worktrees left behind by runs that never got
to end on this machine, the same way: what each left uncommitted is
committed first, a branch with work on it is kept in every case (one its run
left no commit on goes with its worktree), and a worktree the gate has no
record of goes only when it plainly holds nothing that could be lost —
fully pushed, or nothing past its base — unless `--all` says to take it
anyway. A worktree whose run the gate could not be asked about — offline, or
a key it refused — is kept whatever the flags say. `--dry-run` lists without
removing.

### Tools

An agent's `tools` are the shape of its role — the implementer writes, the
reviewers only read. Nothing in gate executes them: the session does an
`executor: gate` node with its own Claude Code tools, and reads the list the
node's instruction carries. For an `executor: gate` agent the names come
from gate's vocabulary and are validated when the agent file is saved, so a
typo fails in the editor rather than in front of the person:

| tool | the role it describes |
| --- | --- |
| `read_file`, `list_files`, `search_files` | reads the worktree |
| `write_file`, `edit_file` | writes in it |
| `run_command` | runs programs in it — tests, builds, git |
| `memory_search`, `memory_feature`, `memory_history` | reads the team's memory |

The memory tools are the ones with a concrete form: the session is told to
run `gate memory search`, `gate memory feature` and `gate memory history` in
their place and to treat what they print as the tool's result. They read
only, and they need no worktree. A `claude-code` agent names Claude Code's
own tools (`Read`, `Grep`, `Bash`, …), which this vocabulary does not check.

The worktree is where the work is confined. A node with a workspace is told
to work in the run's worktree, not the person's checkout; a subagent is told
to use absolute paths under it and nowhere else. The person sees every read,
edit and command in their terminal as it happens, with Claude Code's own
permissions in force, and can interrupt it.

An agent's `timeoutMs` is the point the person is told the node is
overrunning (an hour when the agent names nothing, `0` to turn the notice
off); stopping it is theirs. `maxTokens` and `maxToolIterations` are still
accepted in an agent file and read by nothing.

### Without a workspace

The same agent files work in a workflow without a workspace. With no
worktree, a node is told to work from what the prompt gives it and the
commands it names, and to touch no files on this machine; a subagent is told
to reason over the task and touch no files. The memory commands are kept.
That is the whole difference between a pipeline with a `workspace` and one
without: a place to write, and a project's own `npm ci` / `npm test` as real
command nodes — a worktree is a clean checkout, so dependencies are
installed once before the loop, and an install that fails ends the run
instead of sending the implementer after an error it cannot fix. The `ask`
workflow has no workspace: it reads another team's code through `gate
source`, served by the gate, and nothing of it lands on the asker's disk.

## Key files

- `src/runtime/workspace.ts` — creating, releasing, restoring and summarising a run's worktree; borrowing dependencies; the leftover commit; the diff against the base commit
- `src/client/step.ts` — cutting the worktree at `gate begin`, releasing it when the run ends or is stopped, bringing it back for `gate continue`
- `src/client/repo.ts` — resolving a run's repository: an input, a pin, a connected id mapped by `gate repo`, or the directory the person is in
- `src/client/release.ts` — releasing a run's worktree and publishing its branch
- `src/client/clean.ts` — `gate clean`: which leftover worktrees go, and how
- `src/agents/tools.ts` — the tool vocabulary an `executor: gate` agent file may name
- `src/repos/detect.ts` — the dependency directories a worktree borrows, and a connected repository's detected `setup`

## Pitfalls

- A `git diff` in the worktree against the index shows a finished run as empty, because the shipped agents commit per task. Diff against the base commit (`git diff <base>...<branch>`), which is what the pipeline's own `diff` node and the run page do.
- A workflow pinned to a connected repository id refuses to run on a machine that has not said which clone it means (`gate repo <id> <path>`). It does not guess.
- A connected repository's `setup` runs only in the gate's own checkout. A pipeline that depends on installed or generated output in its worktree needs a `command` node for it.
- The leftover commit is made with `--no-verify`; a project whose hooks are the only thing keeping a rule will not have that rule applied to what a run left uncommitted.
- An agent's `tools` do not fence the session in; the worktree and Claude Code's own permissions do. A reviewer that declares only reads is told its role, not prevented from writing.
- Removing a worktree by hand while its run is going makes the run fail on its next node; the run does not carry on and die later inside some child process.
- `gate reset` keeps worktrees on purpose; `gate clean` is what removes them, and only for runs the gate says are over.

## Decisions

- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0048 — A question to another team is read on the asker's machine, from the commit the gate fixed](../decisions/0048-ask-is-read-on-the-askers-machine.md)
