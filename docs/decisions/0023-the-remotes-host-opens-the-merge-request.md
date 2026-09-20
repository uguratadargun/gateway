# 0023. The remote's host opens the merge request

Status: accepted
Date: 2026-09-20

## Context

The shipped pipelines end at a `merge-request` command node that pushed the
branch and opened the merge request two ways: `glab mr create` when glab was
installed and signed in, and otherwise `git push -o merge_request.create`,
which needs no CLI and no token because GitLab reads the push option itself.

Both are GitLab. A run in a GitHub repository took the second route, because
`glab auth status` fails there, and GitHub does not implement push options at
all: the push itself is refused, the node fails, and the run lands on
`not-shipped` with nothing opened. Measured here on a gate server driving a
GitHub repository: the branch on the remote, the run over, no pull request.

## Decision

The remote's host decides. `git remote get-url origin` matching `github.com`
goes through `gh pr create`; everything else keeps the glab-then-push-options
pair it had. A GitHub remote on a machine whose `gh` is not installed or not
signed in fails the node with a message naming what to install and run, and
does not push first.

## Rationale

Which CLI is installed is not the question — what the host implements is.
Choosing by CLI breaks on a machine that has both: a laptop with glab signed
in against a company GitLab would take the glab branch for a GitHub remote and
fail against the wrong server. The remote URL is the one fact that always
answers correctly, and it is already in the worktree.

GitHub needs a token and there is no way around it: no push option opens a
pull request, so unlike GitLab there is no tokenless fallback to reach for.
That makes "gh is not signed in here" a real terminal state rather than
something to work around, and the honest thing is to say it before the push
rather than after — a pushed branch with no pull request looks, to the person
reading the run, exactly like a run that shipped.

Order matters within the GitHub branch for the same reason it does within the
GitLab one: signed-in is checked up front. A `gh` that fails after the push has
happened leaves nothing to fall back to.

## Alternatives

Try glab, then gh, then push options — first that works wins. Simple to write
and wrong on any machine with both CLIs, which is most of them: the failure is
a 401 against a server that never had this repository.

Ask the repository's record which host it is. gate already knows a repository's
source URL on the server, but a run driven from a session works in a worktree
of a checkout it was handed; the remote in that worktree is the truth, and it
costs one command to read.

Make it a workflow input the team sets per repository. That is a setting for
something the machine can see for itself, and a setting is one more thing to
get wrong when a repository moves host.

Push first, then try to open the pull request, and report the failure. That is
the behaviour this decision removes: it produces a branch on the remote and a
run that reads as finished, which is how this went unnoticed.

## How it works

The `merge-request` node's script (`src/workflows/defaults.ts`, shared by `dev`,
`dev-super` and `dev-quick`) is a `case` on `git remote get-url origin`. The
`*github.com*` arm checks `command -v gh` and `gh auth status`, then pushes and
runs `gh pr create --fill --title "$t"` — the title is the task's first line,
as before, and `--fill` takes the body from the commits. The other arm is
unchanged. The base branch is GitHub's default for the repository, which is
the branch gate's checkout sits on and cuts worktrees from.

A live gate keeps its own copy of the shipped workflows, so
`npm run defaults:restore -- --refresh` is what takes the new node; a run pins
its definitions when it begins, so runs already in flight keep the old one.

## Consequences

A gate server that drives GitHub repositories needs the GitHub CLI installed
and signed in as the user the service runs as. That is a new requirement on the
host, and the node says so when it is not met.

A repository on a GitHub Enterprise host whose URL is not `github.com` takes the
GitLab arm and fails as before. Naming those hosts is a later change; the
message from the GitLab arm is at least about the right repository.

Teams whose designed workflows (`/gate:design`) wrote their own merge-request
node are unaffected — those already use whatever the project's host needs, and
`gh pr create` is what the design command has told them to write for GitHub.

## Touches

- `src/workflows/defaults.ts`
- `tests/defaults.test.ts`
- `docs/design/dev-workflow.md`

## Supersedes

none
