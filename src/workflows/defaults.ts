import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDefaultAgents } from "@/agents/defaults";

import { DEFAULT_TEAM, type DefinitionScope } from "@/lib/def-root";

import { workflowsDir } from "./registry";

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
 * Review is one agent node, not a parallel node with one branch: a parallel
 * node means two regions that genuinely run at once, and the loader is right to
 * refuse one branch. Adding a project's own reviewers alongside this one is
 * /gate:design's job, and the command file says exactly how — wrap them in a
 * parallel node joining at `verdict`, and widen the verdict's condition.
 */
const DEV = `name: Dev
description: Plan a change, carry it out in a worktree, review it, and open a merge request.
entry: planner
workspace: {}
# No ceilings: a change worth making can take a dozen passes, and cutting one
# off mid-review throws away everything it has already spent. The loops end
# themselves — the verdict sends work back, and a run that will not converge is
# stopped from the dashboard, where it can be seen not converging.
maxWorkflowSteps: 0
maxVisits: 0
maxCostUsd: 0
nodes:
  - id: planner
    type: agent
    agent: planner
    label: Plan
    next: implementer

  - id: implementer
    type: agent
    agent: implementer
    label: Implement
    next: stage

  - id: stage
    type: command
    label: Stage new files
    # add -N records intent only: it makes files that did not exist before
    # visible to \`git diff\` without staging their content.
    command: [git, add, -N, .]
    next: diff

  - id: diff
    type: command
    label: Diff
    command: [git, diff]
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
      - to: planner
        label: changes requested

  - id: stage-all
    type: command
    label: Stage everything
    # add -A, not add -N: the stage node above recorded intent, and a commit
    # needs the content.
    command: [git, add, -A]
    next: commit

  - id: commit
    type: command
    label: Commit
    # Two -m: the task is the subject, the implementer's own summary the body.
    command: [git, commit, -m, "{{input.task}}", -m, "{{outputs.implementer.summary}}"]
    edges:
      - when: outputs.commit.ok == true
        to: merge-request
        label: committed
      - to: not-shipped
        label: commit failed

  - id: merge-request
    type: command
    label: Push and open the merge request
    # glab when it is there, and GitLab's push options when it is not: those
    # need no CLI and no API token, because the SSH key that cloned the
    # repository is already the whole authentication story.
    #
    # The task rides as \$1 rather than being pasted into the script. Nothing in
    # gate ever builds a shell string out of a run's own values, and a task is
    # the most user-written value there is.
    command:
      - sh
      - -c
      - >-
        if command -v glab >/dev/null 2>&1; then
        git push --set-upstream origin HEAD && glab mr create --fill --yes;
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

  - id: nothing-changed
    type: terminal
    label: Nothing was changed
    status: failed

  - id: not-shipped
    type: terminal
    label: Reviewed, but not shipped
    status: failed
`;

export const DEFAULT_WORKFLOWS: Record<string, string> = {
  dev: DEV,
};

/** The shipped workflows this scope does not have. See `writeMissingDefaultAgents`. */
export function writeMissingDefaultWorkflows(scope?: DefinitionScope): string[] {
  const dir = workflowsDir(scope);
  const written: string[] = [];
  for (const [id, source] of Object.entries(DEFAULT_WORKFLOWS)) {
    const file = join(dir, `${id}.yaml`);
    if (existsSync(file)) continue;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, source, { mode: 0o600 });
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
