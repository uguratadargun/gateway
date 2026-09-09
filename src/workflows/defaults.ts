import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { backupStamp, ensureDefaultAgents } from "@/agents/defaults";

import { DEFAULT_TEAM, ownScope, type DefinitionScope } from "@/lib/def-root";

import { readWorkflowSource, workflowExists, workflowsDir } from "./registry";

/**
 * The sample pipeline gate ships with, seeded next to the default agents on
 * first access. Same rule as the agents: written only when the directory does
 * not exist yet, so deleting it sticks.
 */

/**
 * The pipeline gate ships.
 *
 * It has to work in a repository nobody has looked at, which is the whole
 * reason it contains no `npm ci` and no `npm test`: those are facts about one
 * project, and a default that assumes them is a default that fails on the
 * first machine it meets. Verification lives inside the implementer, whose
 * test-driven-development skill finds how this project actually runs its
 * tests; a deterministic test node is something `/gate:design` adds once it
 * has read the repository and knows the command.
 *
 * The diff is taken against the commit the run started from, not against the
 * index. The agents' skills commit as they go — writing plans puts a commit in
 * every task, subagent-driven development commits after each one — and a
 * plain `git diff` after that is empty: the run would end at "nothing was
 * changed" with a branch full of work. `base` records the starting commit
 * before anything else runs, `diff` compares the working tree to it, and the
 * reviewer is handed both. For the same reason the commit at the end is
 * allowed to find nothing left to commit.
 *
 * The person is in the graph three times. `clarify` carries the planner's
 * questions to them and their answers back — the planner runs in its own
 * model and its own process, and cannot ask from there. `plan-review` shows
 * them the plan, and nothing is built until they approve it. And between the
 * commit and the merge request stands `acceptance`
 * tells them the branch is ready and how to try it, and only their answer
 * opens the merge request or sends the work back to the planner with what
 * they asked for. Unattended, that node cannot ask, so it holds, and the run
 * ends with the branch committed and unpushed.
 *
 * Review is one agent node, not a parallel node with one branch: a parallel
 * node means two regions that genuinely run at once, and the loader is right to
 * refuse one branch. Adding a project's own reviewers alongside this one is
 * /gate:design's job, and the command file says exactly how — wrap them in a
 * parallel node joining at `verdict`, and widen the verdict's condition.
 */
const DEV = `name: Dev
description: Plan a change with the person, build it in a worktree once they approve the plan, review it, let them try it, and open a merge request.
entry: base
workspace: {}
# No engine ceilings: rounds and revisits cannot be counted in advance, and
# cutting a run off mid-review throws away everything it has already spent.
# The loops end themselves instead — the verdict sends work back, and the
# review loop has its own give-up edge below, landing on a terminal that says
# what is stuck rather than on "node ran N times".
maxWorkflowSteps: 0
maxVisits: 0
maxCostUsd: 0
nodes:
  - id: base
    type: command
    label: Record the starting commit
    # format: (not tformat:) prints no trailing newline, so the output is a
    # bare commit id that can be handed straight to git again.
    command: [git, log, "-1", --format=format:%H]
    next: planner

  - id: planner
    type: agent
    agent: planner
    label: Plan
    next: plan-check

  - id: plan-check
    type: condition
    label: Questions for the person?
    edges:
      # As many rounds as the person and the planner need: a question is not
      # a failure, and the person is there to answer it or to stop the run.
      - when: outputs.planner.questions != ""
        to: clarify
        label: has questions
      - to: plan-review
        label: has a plan

  - id: clarify
    type: agent
    agent: clarify
    label: Ask the person
    next: planner

  - id: plan-review
    type: agent
    agent: plan-review
    label: Show the plan
    next: plan-decision

  - id: plan-decision
    type: condition
    label: Build it?
    edges:
      - when: outputs.plan-review.decision == "approve"
        to: implementer
        label: approved by the person
      - when: outputs.plan-review.decision == "revise"
        to: planner
        label: changes to the plan
      # "hold", and anything else: nobody was there to ask.
      - to: awaiting-plan-approval
        label: nobody to ask

  - id: implementer
    type: agent
    agent: implementer
    label: Implement
    edges:
      - when: outputs.implementer.changed == false
        to: nothing-changed
        label: deliberately changed nothing
      - to: stage
        label: implemented

  - id: stage
    type: command
    label: Stage new files
    # add -N records intent only: it makes files that did not exist before
    # visible to \`git diff\` without staging their content.
    command: [git, add, -N, .]
    next: diff

  - id: diff
    type: command
    label: Diff against the starting commit
    # The working tree against the base commit: what the implementer committed
    # and what it left uncommitted, in one diff.
    command: [git, diff, "{{outputs.base.stdout}}"]
    edges:
      - when: outputs.diff.stdout == ""
        to: nothing-changed
        label: nothing changed
      - to: reviewer
        label: has a diff

  - id: reviewer
    type: agent
    agent: reviewer
    label: Review
    next: verdict

  - id: verdict
    type: condition
    label: Ships?
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: stage-all
        label: approved
      # Declared after the success edge and before the loop-back: edges are
      # tried in order. Counted in reviews, not plans — the planner also runs
      # for the person's questions and plan revisions, which are not failures.
      # Four reviews without shipping is a change that is not converging, and
      # the branch is still there to be looked at.
      - when: visits.reviewer >= 4
        to: review-stuck
        label: still rejected after 4 reviews
      - to: planner
        label: changes requested

  - id: stage-all
    type: command
    label: Stage everything
    # add -A, not add -N: the stage node above recorded intent, and a commit
    # needs the content.
    command: [git, add, -A]
    next: staged

  - id: staged
    type: command
    label: Anything left to commit?
    # --quiet exits 0 when the index matches HEAD — the implementer's skills
    # already committed everything — and 1 when there is something to commit.
    command: [git, diff, --cached, --quiet]
    edges:
      - when: outputs.staged.ok == true
        to: acceptance
        label: already committed
      - to: commit
        label: has staged changes

  - id: commit
    type: command
    label: Commit
    # Two -m: the task is the subject, the implementer's own summary the body.
    command: [git, commit, -m, "{{input.task}}", -m, "{{outputs.implementer.summary}}"]
    edges:
      - when: outputs.commit.ok == true
        to: acceptance
        label: committed
      - to: not-shipped
        label: commit failed

  - id: acceptance
    type: agent
    agent: acceptance
    label: Try it
    next: decision

  - id: decision
    type: condition
    label: Open the merge request?
    edges:
      - when: outputs.acceptance.decision == "ship"
        to: merge-request
        label: approved by the person
      - when: outputs.acceptance.decision == "revise"
        to: planner
        label: changes requested by the person
      # "hold", and anything else: nobody was there to ask. The branch stays
      # committed and unpushed, and the merge request waits for a person.
      - to: awaiting-approval
        label: nobody to ask

  - id: merge-request
    type: command
    label: Push and open the merge request
    # glab when it is there and signed in, and GitLab's push options when it is
    # not: those need no CLI and no API token, because the SSH key that cloned
    # the repository is already the whole authentication story.
    #
    # Signed in is checked up front, not discovered. Push options only take
    # effect on a push that moves the branch, so a glab that fails after the
    # push has already happened leaves nothing to fall back to — measured
    # here: a revoked token, a 401 from \`glab mr create\`, and a branch on the
    # remote with no merge request. \`glab auth status\` fails on a token the
    # host rejects, which is the case that has to take the other branch.
    #
    # The task rides as \$1 rather than being pasted into the script. Nothing in
    # gate ever builds a shell string out of a run's own values, and a task is
    # the most user-written value there is.
    command:
      - sh
      - -c
      - >-
        if command -v glab >/dev/null 2>&1 && glab auth status >/dev/null 2>&1; then
        git push --set-upstream origin HEAD && glab mr create --fill --yes --title "\$1";
        else
        git push -o merge_request.create -o "merge_request.title=\$1" --set-upstream origin HEAD;
        fi
      - gate-open-mr
      - "{{input.task}}"
    edges:
      - when: outputs.merge-request.ok == true
        to: done
        label: merge request opened
      - to: not-shipped
        label: push failed

  - id: done
    type: terminal
    label: Merge request opened
    status: completed

  - id: awaiting-approval
    type: terminal
    label: Committed on the branch, awaiting your approval before a merge request
    status: completed

  - id: awaiting-plan-approval
    type: terminal
    label: Plan written, awaiting your approval before anything is built
    status: completed

  - id: nothing-changed
    type: terminal
    label: Nothing was changed
    status: failed

  - id: review-stuck
    type: terminal
    label: Review never approved
    status: failed

  - id: not-shipped
    type: terminal
    label: Reviewed, but not shipped
    status: failed
`;

export const DEFAULT_WORKFLOWS: Record<string, string> = {
  dev: DEV,
};

/**
 * The shipped workflows this scope cannot resolve, inheritance included.
 * See `writeMissingDefaultAgents`.
 */
export function writeMissingDefaultWorkflows(scope?: DefinitionScope): string[] {
  const dir = workflowsDir(scope && ownScope(scope));
  const written: string[] = [];
  for (const [id, source] of Object.entries(DEFAULT_WORKFLOWS)) {
    if (workflowExists(id, scope)) continue;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.yaml`), source, { mode: 0o600 });
    written.push(id);
  }
  return written;
}

/** Shipped pipelines this scope holds its own, changed copy of; see staleDefaultAgents. */
export function staleDefaultWorkflows(scope?: DefinitionScope): string[] {
  const own = scope && ownScope(scope);
  return Object.entries(DEFAULT_WORKFLOWS)
    .filter(([id, shipped]) => existsSync(join(workflowsDir(own), `${id}.yaml`)) && readWorkflowSource(id, own) !== shipped)
    .map(([id]) => id);
}

/** Rewrites the stale ones to what ships now, the old text kept under backups/<stamp>/workflows/. */
export function refreshDefaultWorkflows(scope?: DefinitionScope, stamp = backupStamp()): string[] {
  const own = scope && ownScope(scope);
  const dir = workflowsDir(own);
  const written: string[] = [];
  for (const id of staleDefaultWorkflows(scope)) {
    const backup = join(dir, "..", "backups", stamp, "workflows");
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    writeFileSync(join(backup, `${id}.yaml`), readWorkflowSource(id, own), { mode: 0o600 });
    writeFileSync(join(dir, `${id}.yaml`), DEFAULT_WORKFLOWS[id], { mode: 0o600 });
    written.push(id);
  }
  return written;
}

/**
 * Write the default workflows if ~/.gate/workflows has never been created.
 * Agents are seeded first: a workflow that references a missing agent fails
 * validation at load time.
 */
export function ensureDefaultWorkflows(scope?: DefinitionScope): void {
  ensureDefaultAgents(scope);
  // Only the default team is seeded; see ensureDefaultAgents for why.
  if (scope && scope.teamId !== DEFAULT_TEAM) return;
  const dir = workflowsDir(scope);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [id, source] of Object.entries(DEFAULT_WORKFLOWS)) {
    writeFileSync(join(dir, `${id}.yaml`), source, { mode: 0o600 });
  }
}
