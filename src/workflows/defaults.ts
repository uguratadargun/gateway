import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDefaultAgents } from "@/agents/defaults";

import { workflowsDir } from "./registry";

/**
 * The sample pipeline gate ships with, seeded next to the default agents on
 * first access. Same rule as the agents: written only when the directory does
 * not exist yet, so deleting it sticks.
 */

const SAMPLE_DEV_PIPELINE = `name: Sample dev pipeline
description: Plan, implement and test a task, then review and security-review it in parallel, looping back to implementation on any rejection.
entry: planner
maxWorkflowSteps: 40
maxVisits: 4
nodes:
  - id: planner
    type: agent
    agent: planner
    label: Plan
    next: implementation

  - id: implementation
    type: agent
    agent: implementation
    label: Implement
    next: tester

  - id: tester
    type: agent
    agent: tester
    label: Test
    edges:
      - when: outputs.tester.passed == true
        to: checks
        label: tests pass
      - to: implementation
        label: tests failed

  # Both reviews read the same diff and nothing else, so they run together.
  - id: checks
    type: parallel
    label: Reviews
    branches: [reviewer, security]
    join: verdict

  - id: reviewer
    type: agent
    agent: reviewer
    label: Review
    next: verdict

  - id: security
    type: agent
    agent: security-reviewer
    label: Security review
    next: verdict

  - id: verdict
    type: condition
    label: Both approved?
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
        label: approved
      - to: implementation
        label: changes requested

  - id: done
    type: terminal
    label: Done
    status: completed
`;


/**
 * The tool-using team: agents work in a per-run git worktree of a real
 * repository, the test suite is a deterministic command node, and any failure
 * or rejection routes back to the implementer. Edit `workspace.repo` to point
 * at your project before running it.
 */
const REPO_DEV_TEAM = `name: Repo dev team
description: Plan, implement and test a change inside a per-run git worktree, then review and security-review it in parallel.
entry: planner
workspace:
  repo: /path/to/your/repo
  # baseRef: main          # what the run branches from (default HEAD)
  # branchPrefix: gate/run
maxWorkflowSteps: 60
maxVisits: 5
nodes:
  - id: planner
    type: agent
    agent: planner
    label: Plan
    next: implementation

  - id: implementation
    type: agent
    agent: implementation
    label: Implement
    next: tests

  # Deterministic verification: the routing decision is an exit code, not a
  # model's opinion. Runs in the worktree, because the workflow has a workspace.
  - id: tests
    type: command
    label: npm test
    command: [npm, test]
    edges:
      - when: outputs.tests.ok == true
        to: checks
        label: tests pass
      - to: implementation
        label: tests failed

  - id: checks
    type: parallel
    label: Reviews
    branches: [reviewer, security]
    join: verdict

  - id: reviewer
    type: agent
    agent: reviewer
    label: Review
    next: verdict

  - id: security
    type: agent
    agent: security-reviewer
    label: Security review
    next: verdict

  - id: verdict
    type: condition
    label: Both approved?
    edges:
      - when: outputs.reviewer.verdict == "approved" && outputs.security.verdict == "approved"
        to: done
        label: approved
      - to: implementation
        label: changes requested

  - id: done
    type: terminal
    label: Done
    status: completed
`;

export const DEFAULT_WORKFLOWS: Record<string, string> = {
  "sample-dev-pipeline": SAMPLE_DEV_PIPELINE,
  "repo-dev-team": REPO_DEV_TEAM,
};

/**
 * Write the default workflows if ~/.gate/workflows has never been created.
 * Agents are seeded first: a workflow that references a missing agent fails
 * validation at load time.
 */
export function ensureDefaultWorkflows(): void {
  ensureDefaultAgents();
  const dir = workflowsDir();
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [id, source] of Object.entries(DEFAULT_WORKFLOWS)) {
    writeFileSync(join(dir, `${id}.yaml`), source, { mode: 0o600 });
  }
}
