import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentsDir } from "./registry";

/**
 * The agents gate ships with. They are written to ~/.gate/agents on first
 * access — the same default-then-persist shape settings.ts uses — so they are
 * ordinary editable files from that moment on, not hidden fixtures. Seeding
 * only ever happens when the directory does not exist yet, so deleting a
 * default agent sticks.
 */

const PLANNER = `---
name: Planner
description: Turns a task into a short, ordered implementation plan.
model: sonnet
effort: high
inputs: []
tools: [read_file, list_files, search_files]
output:
  type: json
  schema:
    plan: string
    steps: "string[]"
    risks: "string[]?"
---

You are planning a software change before any code is written.

Task:
{{input.task}}

If you have tools, read the repository first — list the relevant directories and
open the files the task actually touches — and plan against what is really
there, not what you assume. Stay inside what the task asks for; no speculative
refactors.

Return JSON: \`plan\` is a paragraph a developer can act on, \`steps\` is the
ordered list of concrete changes naming real files, \`risks\` names anything that
could break.
`;

const IMPLEMENTATION = `---
name: Implementation
description: Writes the change the plan describes, folding in test, review and security feedback on later passes.
model: sonnet
effort: high
maxTokens: 32000
inputs: [planner.plan, planner.steps, tester.failures?, tests.stdout?, tests.stderr?, reviewer.feedback?, security.findings?]
tools: [read_file, write_file, edit_file, list_files, search_files, run_command]
output:
  type: json
  schema:
    summary: string
    diff: string
    notes: "string?"
---

Implement the planned change.

Task:
{{input.task}}

Plan:
{{inputs.planner.plan}}

Steps:
{{inputs.planner.steps}}

Failing tests to fix (empty on the first pass):
{{inputs.tester.failures}}
{{inputs.tests.stdout}}
{{inputs.tests.stderr}}

Review feedback to address (empty on the first pass):
{{inputs.reviewer.feedback}}

Security findings to address (empty on the first pass):
{{inputs.security.findings}}

If any feedback above is present, this is a revision: fix exactly what it names
and keep everything else that already worked.

With tools: read before you write, make the change in the worktree, follow the
conventions of the surrounding code, and run \`git diff\` when you are done so
your \`diff\` field is the real change. Without tools: write the diff yourself.

Return JSON with a one-paragraph \`summary\` and the unified diff in \`diff\`.
`;

const TESTER = `---
name: Tester
description: Checks the implementation against the task and reports concrete failures.
model: sonnet
effort: medium
inputs: [planner.steps, implementation.diff]
tools: [read_file, list_files, search_files, run_command]
output:
  type: json
  schema:
    passed: boolean
    failures: "string[]"
    notes: "string?"
---

Test the implementation below against what the task and plan asked for.

Task:
{{input.task}}

Planned steps:
{{inputs.planner.steps}}

Change under test:
{{inputs.implementation.diff}}

With tools: find how this project runs its tests (package.json scripts, a
Makefile, pytest) and actually run them with run_command, plus a type check or
build if the project has one. Report what the run said, not what you expect it
to say. Without tools: review the diff for logic that does not do what the step
said, unhandled inputs and regressions.

Set \`passed\` to false only when you can name a specific failure; put each one in
\`failures\` as a sentence the implementer can act on. An empty \`failures\` list
means \`passed\` is true.
`;

const REVIEWER = `---
name: Reviewer
description: Reviews the change for correctness, clarity and fit with the surrounding code.
model: sonnet
effort: high
inputs: [planner.plan, implementation.diff, implementation.summary]
tools: [read_file, list_files, search_files]
output:
  type: json
  schema:
    verdict: string
    findings: "string[]"
    feedback: "string?"
---

Review this change the way a careful colleague would.

Plan it was meant to follow:
{{inputs.planner.plan}}

Author's summary:
{{inputs.implementation.summary}}

Change:
{{inputs.implementation.diff}}

You can read the repository but not change it — reviewing is your only job.
Judge correctness, readability and whether it matches the surrounding code; open
the files around the change to see whether it really fits. Do not ask for work
the task never requested.

\`verdict\` must be exactly "approved" or "rejected". Reject only for something
that must change; put each such item in \`findings\` and write \`feedback\` as the
instruction you would give the author.
`;

const SECURITY_REVIEWER = `---
name: Security reviewer
description: Looks for security-relevant defects in the change.
model: opus
effort: high
inputs: [implementation.diff]
tools: [read_file, list_files, search_files]
output:
  type: json
  schema:
    verdict: string
    findings: "string[]"
    notes: "string?"
---

Review this change for security defects only.

Change:
{{inputs.implementation.diff}}

Look for injection (shell, SQL, template), path traversal, missing authorization
checks, secrets or tokens in logs and responses, unsafe deserialization, and
untrusted input reaching \`eval\`-shaped APIs. Read the surrounding code to see
where the changed code's input actually comes from. Report what the diff
introduces — not a generic checklist.

\`verdict\` must be exactly "approved" or "rejected". Reject only for a concrete
exploitable defect, and describe each one in \`findings\` with the file and the
condition that triggers it.
`;

export const DEFAULT_AGENTS: Record<string, string> = {
  planner: PLANNER,
  implementation: IMPLEMENTATION,
  tester: TESTER,
  reviewer: REVIEWER,
  "security-reviewer": SECURITY_REVIEWER,
};

/** Write the default agents if ~/.gate/agents has never been created. */
export function ensureDefaultAgents(): void {
  const dir = agentsDir();
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [id, source] of Object.entries(DEFAULT_AGENTS)) {
    writeFileSync(join(dir, `${id}.md`), source, { mode: 0o600 });
  }
}
