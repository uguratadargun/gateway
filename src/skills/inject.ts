import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { gateHome } from "@/lib/def-root";

import { withSkillName } from "./loader";
import { ORIGIN_FILE } from "./registry";
import type { SkillDefinition } from "./types";

/**
 * How an agent's declared skills reach the model.
 *
 * Two executors, two mechanisms, one meaning. A spawned Claude Code already
 * knows what a skill is, so gate builds the skills the agent named into a
 * throwaway plugin and points the child at it: the skill loads the way it was
 * written to, its own files beside it, and the harness decides when to open it.
 * Gate's own loop has no such notion and no way to read a file outside the
 * worktree, so there the skill's prose is folded into the system prompt
 * instead — everything it says, minus the files it can point at.
 *
 * Either way the agent is *told* which skills it holds. A description is how a
 * model decides to reach for a skill on its own, and "on its own" is not what
 * an agent definition means when it names one: a planner that declares
 * brainstorming is a planner that brainstorms, every run.
 */

/** Bundle directories to keep before the oldest are swept. */
const MAX_BUNDLES = 20;

/** The system-prompt section for gate's own loop. */
export function skillsBriefing(skills: SkillDefinition[]): string {
  if (!skills.length) return "";
  const list = skills.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  const bodies = skills
    .map((s) => {
      const files = s.resources.length
        ? `\n\n(This skill also ships ${s.resources.join(", ")}. Those files are not readable from this` +
          ` workspace — work from what is written above, and do not claim to have opened them.)`
        : "";
      return `## Skill: ${s.id}\n\n${s.body}${files}`;
    })
    .join("\n\n---\n\n");
  return (
    `\n\n# Skills\n\nYou have been given these skills, and you are expected to work the way they say:\n${list}\n\n` +
    `They are instructions, not references: where a skill describes a process, follow it.\n\n${bodies}`
  );
}

/**
 * The plugin gate builds is loaded under its own name, so the child sees each
 * skill as `gate-skills:<id>` rather than as the bare id. Naming them the way
 * the harness does is what lets the model invoke the right one instead of
 * looking for a skill under a name that is not there.
 */
export const SKILL_PLUGIN_NAME = "gate-skills";

/** What a spawned Claude Code is told about the plugin it has been handed. */
export function skillsDirective(skills: SkillDefinition[]): string {
  const list = skills.map((s) => `- ${SKILL_PLUGIN_NAME}:${s.id} — ${s.description}`).join("\n");
  return (
    `You have been given these skills, and this node is expected to be done the way they say:\n${list}\n\n` +
    `Use each one before you start, by its full name above, and follow it. A skill that describes a process is ` +
    `the process for this node, not background reading.`
  );
}

/**
 * What a node is told when nothing it does can be answered.
 *
 * The skills an agent follows were written for a session with a person in it:
 * brainstorming stops at an approval gate, executing plans raises concerns
 * "before starting". Run headless, or on gate's own loop, a question has no
 * one to reach — so the node is told so, and told what to do instead.
 *
 * Who gets it follows the executor, not the driver. Every `claude-code` node
 * does — as a worker on the server or on a laptop, and as a subagent of the
 * person's session too, because a subagent cannot ask the person either. An
 * `executor: gate` node run by the session itself never does: there the
 * person is right there, and a skill that asks should ask. Deciding this from
 * the prompt's wording was tried; the model guessed "unattended" with a user
 * watching, and approved its own plan. So the notice is issued in exactly two
 * places — the claude-code executor and the session's delegate instruction —
 * and an agent prompt may rely on that: a claude-code agent is always
 * unattended, and a prompt that hedges "when there is a person" is hedging
 * against a case that does not happen.
 */
export function unattendedNotice(): string {
  return (
    "This node is running unattended: there is no person in this session, and a question you ask here reaches " +
    "nobody. Where a skill you follow would stop for approval, ask a clarifying question, or raise a concern " +
    "before starting, do not wait for a reply here. If the prompt below gives such questions a way out — an " +
    "output field they go into, so that the run can put them to the person elsewhere — put them there, all of " +
    "them, and stop; the person decides, not you, and a decision you take in their place is a defect. Only where " +
    "the prompt gives no such way out, or tells you the person has already been asked and was not there, take the " +
    "reading a careful colleague would take, act on it, and record the ruling where the skill's process would " +
    "have recorded the answer (the plan file, the ledger, your summary), so that a wrong one can be seen and undone."
  );
}

/**
 * How subagents behave in a Claude Code that gate drives, which the skills
 * do not know: subagent-driven development was written for a harness whose
 * dispatch blocks until the subagent answers, and in this one it does not.
 * Measured here: an implementer that dispatched a review and then slept in a
 * shell loop for eight minutes waiting for a report file — eighty sleeps in
 * one reviewer — with the result already delivered as a notification. And,
 * in the run after, an implementer that dispatched five tasks, wrote "ending
 * my turn to let it run", and was resumed nine minutes later by the
 * notification with the tasks committed: ending the turn is the mechanism,
 * not the end of the node, and the note says so in as many words, because a
 * model reading "end your turn" as "finish" would hand in half a change.
 */
export function backgroundSubagentNotice(): string {
  return (
    "Subagents you dispatch with the Agent tool run in the background: the call returns as soon as the subagent " +
    "is launched, and its result reaches you as a notification. Ending your turn while one of yours is still " +
    "running does not finish this node — you are resumed with the result when it completes. So after " +
    "dispatching, do whatever work does not depend on the result, then say what you are waiting on and stop; " +
    "never poll for its commits or a report file, and never sleep in a shell loop, because the result was on " +
    "its way and a turn spent sleeping is one in which it cannot arrive. Your final answer comes only when " +
    "nothing you dispatched is still running."
  );
}

export function bundlesDir(): string {
  return join(gateHome(), "skill-bundles");
}

/**
 * Content-addressed, so the same set of skills is built once and reused by
 * every node that names it — and a skill edited between runs produces a new
 * address rather than a stale plugin nobody notices is stale.
 */
function fingerprint(skills: SkillDefinition[]): string {
  const h = createHash("sha256");
  for (const skill of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(`skill:${skill.id}\n`);
    for (const file of ["SKILL.md", ...skill.resources]) {
      const full = join(skill.dir, file);
      try {
        const stat = statSync(full);
        h.update(`${file}:${stat.size}:${stat.mtimeMs}\n`);
      } catch {
        // A file that vanished between listing and hashing changes the answer
        // as much as one that changed, which is exactly what should happen.
        h.update(`${file}:missing\n`);
      }
    }
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Build the skills an agent named into a Claude Code plugin, and return its
 * directory for `--plugin-dir`.
 *
 * A plugin rather than files dropped into the worktree: the worktree is the
 * run's deliverable, and a diff carrying gate's own scaffolding is a diff
 * somebody has to clean up before it can be merged.
 */
export function buildSkillPlugin(skills: SkillDefinition[]): string | null {
  if (!skills.length) return null;
  const root = join(bundlesDir(), fingerprint(skills));
  const marker = join(root, ".claude-plugin", "plugin.json");
  if (existsSync(marker)) return root;

  const staging = `${root}.${process.pid}.${Date.now()}`;
  mkdirSync(join(staging, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(staging, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: SKILL_PLUGIN_NAME,
        description: "Skills this node's agent declared, assembled by gate.",
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  for (const skill of skills) {
    const target = join(staging, "skills", skill.id);
    cpSync(skill.dir, target, {
      recursive: true,
      // Provenance is gate's bookkeeping and would read to the model as part
      // of the skill.
      filter: (src) => basename(src) !== ORIGIN_FILE,
    });
    writeFileSync(join(target, "SKILL.md"), withSkillName(readFileSync(join(skill.dir, "SKILL.md"), "utf8"), skill.id), {
      mode: 0o600,
    });
  }

  // Published under its final name only once it is complete: two nodes starting
  // together must never have one of them read a half-copied plugin.
  try {
    mkdirSync(bundlesDir(), { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      renameSync(staging, root);
    } else {
      rmSync(staging, { recursive: true, force: true });
    }
  } catch {
    // Losing the race is not a failure: the other builder wrote the same bytes.
    rmSync(staging, { recursive: true, force: true });
  }
  prune();
  return existsSync(marker) ? root : null;
}

/** Old bundles are cache, and cache that is never swept is a disk that fills. */
function prune(): void {
  try {
    const dir = bundlesDir();
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ path: join(dir, e.name), mtimeMs: statSync(join(dir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(MAX_BUNDLES)) rmSync(stale.path, { recursive: true, force: true });
  } catch {
    // A sweep that cannot happen leaves the cache larger than intended, which
    // is not worth failing a run over.
  }
}
