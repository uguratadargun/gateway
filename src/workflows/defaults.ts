import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { backupStamp, ensureDefaultAgents } from "@/agents/defaults";

import { DEFAULT_TEAM, ownScope, type DefinitionScope } from "@/lib/def-root";

import { readWorkflowSource, workflowExists, workflowsDir } from "./registry";

/**
 * The pipelines gate ships with, seeded next to the default agents on first
 * access. Same rule as the agents: written only when the directory does not
 * exist yet, so deleting one sticks.
 */

/**
 * The pipeline gate ships.
 *
 * It has to work in a repository nobody has looked at, which is the whole
 * reason it contains no `npm ci` and no `npm test`: those are facts about one
 * project, and a default that assumes them is a default that fails on the
 * first machine it meets. Verification lives in the agents — the planner
 * finds how this project runs its tests and records the baseline, the
 * implementer runs them as it goes, the verifier runs them whole at the end;
 * a deterministic test node is something `/gate:design` adds once it has
 * read the repository and knows the command.
 *
 * The diff is taken against the commit the run started from, not against the
 * index. The implementer commits as it goes — one commit per task, so the log
 * is its record of what is done — and a plain `git diff` after that is
 * empty: the run would end at "nothing was changed" with a branch full of
 * work. `base` records the starting commit before anything else runs, `diff`
 * compares the working tree to it, and the reviewer is handed both. For the
 * same reason the commit at the end is allowed to find nothing left to
 * commit.
 *
 * The four working agents follow no skill; see src/agents/defaults.ts for
 * what each carries instead. `dev-super` below is this same graph on the
 * `super-*` agents, which follow the superpowers skills — derived from this
 * text rather than copied, so the two pipelines cannot drift apart.
 *
 * The person is in the graph three times. `clarify` carries the planner's
 * questions to them and their answers back — the planner runs in its own
 * model and its own process, and cannot ask from there. `plan-review` shows
 * them the plan, and nothing is built until they approve it — once. After
 * that a revision of the plan, whether a reviewer sent it back or the person
 * asked for changes on the finished branch, goes straight to the implementer:
 * `plan-check` reads the approval that is still in the outputs and skips the
 * gate, and the planner's questions are still the way to the person if a
 * revision needs one. And between the
 * commit and the merge request stands `acceptance`, which
 * tells them the branch is ready and how to try it, and only their answer
 * opens the merge request or sends the work back with what they asked for —
 * to the implementer when the request is bounded, to the planner when it
 * changes what was planned; the acceptance node says which, as the reviewer
 * does with `replan`. Unattended, that node cannot ask, so it holds, and the run
 * ends with the branch committed and unpushed.
 *
 * Between the implementer and the diff stands `verifier`: it runs the
 * project's own checks on the tree as it is and holds the plan's tasks
 * against it, so the reviewer reads a change that passed and the merge
 * request carries a suite that was actually run. Its gaps go back to the
 * implementer as tasks, with a give-up edge of its own. And a rejection from
 * the reviewer goes one of two ways, on the reviewer's own say: a bounded
 * fix straight to the implementer, a fault in the plan back to the planner.
 * Measured here: one review finding that named one missing call cost a
 * ten-minute planner pass and a second plan approval when every rejection
 * went to the planner.
 *
 * Review is one agent node, not a parallel node with one branch: a parallel
 * node means two regions that genuinely run at once, and the loader is right to
 * refuse one branch. Adding a project's own reviewers alongside this one is
 * /gate:design's job, and the command file says exactly how — wrap them in a
 * parallel node joining at `verdict`, and widen the verdict's condition.
 */
const DEV = `name: Dev
description: Plan a change with the person, build it in a worktree once they approve the plan, verify and review it, let them try it, and open a merge request. The agents follow no skill; dev-super is the same road with the superpowers method.
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
    next: plan-dir

  - id: plan-dir
    type: command
    label: Keep the plan out of the commit
    # The plan file stays on disk for the implementer, the verifier and the
    # reviewer to read, and out of the commit and the merge request: a
    # docs/plans/.gitignore of "*" ignores the directory, itself included,
    # for this worktree's tree and nothing else — an info/exclude in a
    # linked worktree is the common one, shared with the person's checkout.
    # The reasoning the plan carried travels in the implementer's summary,
    # which is the commit's body. Only written when there is not one already:
    # a project that ships its own docs/plans/.gitignore keeps it.
    command:
      - sh
      - -c
      - >-
        mkdir -p docs/plans &&
        { [ -e docs/plans/.gitignore ] || printf '*\\n' > docs/plans/.gitignore; }
    next: recall

  # What the team already knows, before anything is planned: the same
  # feature built by a sibling team, decisions that hold in the areas the
  # task touches, attempts that were abandoned. The planner reads the brief
  # as recall.brief; a brief that says "nothing" is a real answer.
  - id: recall
    type: agent
    agent: recall
    label: Read the team's memory
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
      # The plan is shown once. A plan-review output of "approve" outlives the
      # node that produced it, so every later visit to the planner — sent back
      # by a reviewer, or by the person's requests on the finished branch — is
      # a revision of a plan the person already said yes to, and goes straight
      # to the implementer. "revise" leaves the output at "revise", and the
      # revised plan is shown again until they approve one.
      - when: outputs.plan-review.decision == "approve"
        to: implementer
        label: revised an approved plan
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
      - to: verifier
        label: implemented

  - id: verifier
    type: agent
    agent: verifier
    label: Verify
    edges:
      - when: outputs.verifier.verified == true
        to: stage
        label: checks green, plan met
      # Counted in verifications: three rounds of the implementer answering
      # the same gaps is a change that is not converging, and the branch is
      # still there to be looked at.
      - when: visits.verifier >= 3
        to: not-verified
        label: still failing after 3 checks
      - to: implementer
        label: gaps to fix

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
      # The reviewer says where its feedback goes. A bounded fix — a bug, a
      # missing test, a file the plan named and the diff did not touch — is
      # the implementer's, against the plan as it stands; a fault in the
      # plan itself goes back to the planner, which rewrites it.
      - when: outputs.reviewer.replan == false
        to: implementer
        label: fix requested
      - to: planner
        label: plan changes requested

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
    # --quiet exits 0 when the index matches HEAD — the implementer already
    # committed everything, task by task — and 1 when there is something to commit.
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
      # The person's request goes where the acceptance node says, the way a
      # rejection goes where the reviewer says: a bounded change — a wording,
      # a name, a small fix in what the branch already has — is one more task
      # for the implementer, against the plan as it stands; a change to what
      # was planned goes to the planner first. Measured here: a request to
      # translate commit messages, sent through the planner, cost a seven-
      # minute plan and a nine-minute build.
      - when: outputs.acceptance.decision == "revise" && outputs.acceptance.replan == false
        to: implementer
        label: bounded change requested by the person
      - when: outputs.acceptance.decision == "revise"
        to: planner
        label: plan changes requested by the person
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
    #
    # The title is the task's first line, not the task: a brief is often
    # several paragraphs, and git refuses a push option with a newline in it
    # ("push options must not have new line characters") — measured here, a
    # run whose every node had passed, failing at the push. The whole task is
    # already in the commit.
    command:
      - sh
      - -c
      - >-
        t=$(printf '%s\\n' "\$1" | sed -n 1p);
        if command -v glab >/dev/null 2>&1 && glab auth status >/dev/null 2>&1; then
        git push --set-upstream origin HEAD && glab mr create --fill --yes --title "$t";
        else
        git push -o merge_request.create -o "merge_request.title=$t" --set-upstream origin HEAD;
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

  - id: not-verified
    type: terminal
    label: Verification never passed
    status: failed

  - id: not-shipped
    type: terminal
    label: Reviewed, but not shipped
    status: failed
`;

/**
 * The same road with the superpowers method.
 *
 * Derived from `dev`, not copied: the graph is `dev`'s to the byte, with
 * the four working agents swapped for their `super-*` counterparts, so a
 * change to one pipeline's shape is a change to both and there is nothing
 * to keep in step by hand. What differs is entirely inside the agents — the
 * skills they follow, the spec document, the ledger, the subagent per task,
 * the dispatched reviewer — and that is where the time goes: measured here,
 * eighty minutes for a seven-task change against the same graph. It is
 * here for the team that wants the method's full weight, and it is the
 * only shipped pipeline that needs skills imported.
 */
const DEV_SUPER = DEV.replace(/^name: Dev$/m, "name: Dev super")
  .replace(
    /^description: .*$/m,
    "description: Dev's road with the superpowers method — the same plan, gates, verifier and review, on the super-* agents, which follow the skills. Slower; for a change worth the method's full weight.",
  )
  .replace(/^(\s+agent: )(planner|implementer|verifier|reviewer)$/gm, "$1super-$2");

/**
 * The short road, for a change that does not need a plan.
 *
 * `dev` earns its length on a change worth planning: a design settled with
 * the person, a plan they approve, a verifier, a reviewer that reads the
 * whole diff. Put "make the save button blue" through it
 * and the same machinery runs on a two-line diff — measured here, most of an
 * hour and three answers from the person for a change they could have
 * described in one. `dev-quick` is the pipeline for that change: something
 * that already exists, adjusted; a colour, a label, a default, a small fix.
 *
 * It has no planner. The brief is settled where the run is started — the
 * run command already asks what is unsettled before it begins — and the
 * quick implementer reads the repository and makes the change, following no
 * skill, recording in its summary any reading it had to take on the
 * person's behalf. It has no verifier: the implementer runs the project's
 * own check for the files it touched, and the reviewer, which reads the
 * diff itself rather than dispatching for it, holds the summary's claim
 * about that check against what it can see and run. Both are told what
 * "small" means, and a task that turns out not to be ends the run as
 * `nothing-changed` with the reason in the summary, so it can be sent
 * through `dev` instead of being half-built here.
 *
 * The person is in the graph once, at `acceptance`, in the same place and
 * with the same agent as in `dev`: nothing leaves the machine until they
 * have tried it, and their requests come back as the brief for another pass
 * of the implementer — there is no planner for them to go to. Unattended,
 * that node holds, and the run ends with the branch committed and unpushed.
 *
 * The git nodes are `dev`'s, for the same reasons: the base is recorded
 * first, the diff is taken against it, the commit is allowed to find nothing
 * to commit, the merge request is opened the same way. The review loop gives
 * up sooner — three reviews, not four — because a small change that has
 * been sent back twice is not converging on anything a third pass will fix.
 */
const DEV_QUICK = `name: Dev quick
description: Make a small change to something that already exists — no plan, no skills — review it, let the person try it, and open a merge request. For a colour, a label, a default, a small fix; anything that needs a plan goes through Dev.
entry: base
workspace: {}
# No engine ceilings, as in dev: the loops end themselves, on the verdict
# and on the give-up edge below.
maxWorkflowSteps: 0
maxVisits: 0
maxCostUsd: 0
nodes:
  - id: base
    type: command
    label: Record the starting commit
    command: [git, log, "-1", --format=format:%H]
    next: recall

  # Even a small change reads memory first: the decision it would quietly
  # undo is the one the quick implementer cannot see in the file.
  - id: recall
    type: agent
    agent: recall
    label: Read the team's memory
    next: implementer

  # Named implementer, not quick-implementer: outputs are keyed by node id,
  # and the shipped acceptance agent reads implementer.summary — the same
  # agent closes both pipelines.
  - id: implementer
    type: agent
    agent: quick-implementer
    label: Change it
    edges:
      # Deliberately nothing: the task was already done, or it turned out
      # not to be small. The summary says which.
      - when: outputs.implementer.changed == false
        to: nothing-changed
        label: deliberately changed nothing
      - to: stage
        label: changed

  - id: stage
    type: command
    label: Stage new files
    command: [git, add, -N, .]
    next: diff

  - id: diff
    type: command
    label: Diff against the starting commit
    command: [git, diff, "{{outputs.base.stdout}}"]
    edges:
      - when: outputs.diff.stdout == ""
        to: nothing-changed
        label: nothing changed
      - to: reviewer
        label: has a diff

  - id: reviewer
    type: agent
    agent: quick-reviewer
    label: Review
    next: verdict

  - id: verdict
    type: condition
    label: Ships?
    edges:
      - when: outputs.reviewer.verdict == "approved"
        to: stage-all
        label: approved
      # Three reviews without shipping is a small change that is not
      # converging, and the branch is still there to be looked at.
      - when: visits.reviewer >= 3
        to: review-stuck
        label: still rejected after 3 reviews
      # Every rejection is a bounded fix here: there is no plan to fault.
      - to: implementer
        label: fix requested

  - id: stage-all
    type: command
    label: Stage everything
    command: [git, add, -A]
    next: staged

  - id: staged
    type: command
    label: Anything left to commit?
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
      # Their requests are the brief for another pass of the implementer —
      # there is no planner in this pipeline for them to go to.
      - when: outputs.acceptance.decision == "revise"
        to: implementer
        label: changes requested by the person
      - to: awaiting-approval
        label: nobody to ask

  - id: merge-request
    type: command
    label: Push and open the merge request
    # The same node as dev's; see the comment there.
    command:
      - sh
      - -c
      - >-
        t=$(printf '%s\\n' "\$1" | sed -n 1p);
        if command -v glab >/dev/null 2>&1 && glab auth status >/dev/null 2>&1; then
        git push --set-upstream origin HEAD && glab mr create --fill --yes --title "$t";
        else
        git push -o merge_request.create -o "merge_request.title=$t" --set-upstream origin HEAD;
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

  - id: nothing-changed
    type: terminal
    label: Nothing was changed; the implementer's summary says why
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
  "dev-super": DEV_SUPER,
  "dev-quick": DEV_QUICK,
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
