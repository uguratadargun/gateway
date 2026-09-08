import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TEAM, type DefinitionScope } from "@/lib/def-root";

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
description: Settles what a change should be, then writes the plan the implementer follows.
model: opus
effort: high
executor: claude-code
skills: [superpowers-brainstorming, superpowers-using-git-worktrees, superpowers-writing-plans]
inputs: [reviewer.feedback?]
tools: [read_file, list_files, search_files]
output:
  type: json
  schema:
    plan: string
    steps: "string[]"
    risks: "string[]?"
---

You are planning a change before any code is written.

Task:
{{input.task}}

{{inputs.reviewer.feedback}}

Read the repository before planning against it — the layout, the files the task
actually touches, the conventions already in use. Plan for what is there rather
than for what the names suggest.

Your skills say how to do this. Brainstorming settles what the task actually
means where it is underspecified: ask, one question at a time, and do not plan
past an answer you have not got. Writing plans says what a plan has to contain
to be executable by someone who was not part of that conversation.

Stay inside what the task asks. A plan that also reorganises something on the
way is a plan whose review will be about the reorganisation.

Return JSON: \`plan\` is the brief a developer can act on, \`steps\` is the ordered
list of concrete changes naming real files, \`risks\` names what could break.
`;

const IMPLEMENTER = `---
name: Implementer
description: Carries out the plan in the run's worktree, and leaves the change there.
model: opus
effort: high
executor: claude-code
skills:
  - superpowers-executing-plans
  - superpowers-test-driven-development
  - superpowers-subagent-driven-development
inputs: [planner.plan, planner.steps, reviewer.feedback?]
tools: [read_file, write_file, edit_file, list_files, search_files, run_command]
timeoutMs: 5400000
output:
  type: json
  schema:
    summary: string
    changed: boolean
---

Carry out this plan in the worktree you are working in.

Plan:
{{inputs.planner.plan}}

Steps:
{{inputs.planner.steps}}

{{inputs.reviewer.feedback}}

The worktree is the output. Nothing reads your summary for the change itself —
you make the edits, you run what verifies them, and what you leave on disk is
what gets reviewed.

Your skills say how. Executing plans is the shape of the work: one step at a
time, verified before moving on, rather than a survey followed by one large edit
at the end. Test-driven development applies wherever this project has tests —
find how they are actually run here (its scripts, its Makefile, its CI) rather
than assuming a command. Subagent-driven development is for a step big enough
that doing it in one pass would lose the thread; use it when that is true and
not otherwise.

If the plan turns out to be wrong, say so in \`summary\` rather than quietly
building something else.

Return JSON: \`summary\` is what you changed and why, in a few sentences;
\`changed\` is false only if you deliberately made no change at all.
`;

const REVIEWER = `---
name: Reviewer
description: Reviews the change the implementer left, and decides whether it ships.
model: opus
effort: high
executor: claude-code
skills: [superpowers-requesting-code-review]
inputs: [planner.plan, implementer.summary]
tools: [read_file, list_files, search_files]
output:
  type: json
  schema:
    verdict: string
    feedback: "string?"
---

Review the change in this worktree.

It was asked for:
{{input.task}}

Planned as:
{{inputs.planner.plan}}

The implementer says:
{{inputs.implementer.summary}}

Read the diff and the files around it. Review what is there against what was
asked — correctness first, then whether it fits the conventions of this
repository. Your skill says what a review has to cover and how to put it.

Judge the change, not the summary: a claim in the summary that the code does
not support is itself a finding.

\`verdict\` is exactly "approved" or "changes-requested". Approve a change that
does what was asked and is safe to merge, even if you would have written parts
of it differently — style preference is not a reason to send work back. Request
changes for something wrong, missing or unsafe, and then \`feedback\` must say
precisely what to change, in the imperative, naming files. That text goes
straight back to the implementer as its next brief.
`;

/**
 * The skills the shipped agents follow, in the form the `superpowers` source
 * imports them under (`prefix` in src/skills/sources.ts).
 *
 * Listed here rather than parsed back out of the prompts: the Skills page uses
 * it to say which of them a team is missing, and a default that names a skill
 * nobody can see is a run that fails halfway with a message about a library
 * the person has never opened.
 */
export const DEFAULT_AGENT_SKILLS: Array<{ id: string; source: string; sourceSkill: string }> = [
  { id: "superpowers-brainstorming", source: "superpowers", sourceSkill: "brainstorming" },
  { id: "superpowers-using-git-worktrees", source: "superpowers", sourceSkill: "using-git-worktrees" },
  { id: "superpowers-writing-plans", source: "superpowers", sourceSkill: "writing-plans" },
  { id: "superpowers-executing-plans", source: "superpowers", sourceSkill: "executing-plans" },
  { id: "superpowers-test-driven-development", source: "superpowers", sourceSkill: "test-driven-development" },
  { id: "superpowers-subagent-driven-development", source: "superpowers", sourceSkill: "subagent-driven-development" },
  { id: "superpowers-requesting-code-review", source: "superpowers", sourceSkill: "requesting-code-review" },
];

export const DEFAULT_AGENTS: Record<string, string> = {
  planner: PLANNER,
  implementer: IMPLEMENTER,
  reviewer: REVIEWER,
};

/**
 * Writes the shipped agents this scope does not have, and says which.
 *
 * Directly, the way seeding writes them, rather than through `saveAgent`:
 * saving refuses an agent naming a skill the team has not imported, and the
 * shipped agents all name skills. Going through it would make restoring the
 * defaults impossible until you had imported skills you could not see the need
 * for — the definitions that name them being the thing you were restoring.
 *
 * Nothing is overwritten. A shipped id already here is left as it is, edits
 * and all.
 */
export function writeMissingDefaultAgents(scope?: DefinitionScope): string[] {
  const dir = agentsDir(scope);
  const written: string[] = [];
  for (const [id, source] of Object.entries(DEFAULT_AGENTS)) {
    const file = join(dir, `${id}.md`);
    if (existsSync(file)) continue;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, source, { mode: 0o600 });
    written.push(id);
  }
  return written;
}

/**
 * Seeds the shipped examples, once, for the install that has never had any.
 *
 * Only the default team. A new team is somebody making a place for their own
 * work, and filling it with five agents and two pipelines they did not write
 * is not a helpful welcome — it is a list they have to read before they can
 * tell which of it is theirs. Worse, one of those samples runs `npm ci` and
 * `npm test`, and with runs happening on developers' own machines the first
 * thing a new person would be offered is a workflow that wants to install
 * dependencies on their laptop.
 */
export function ensureDefaultAgents(scope?: DefinitionScope): void {
  if (scope && scope.teamId !== DEFAULT_TEAM) return;
  const dir = agentsDir(scope);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [id, source] of Object.entries(DEFAULT_AGENTS)) {
    writeFileSync(join(dir, `${id}.md`), source, { mode: 0o600 });
  }
}
