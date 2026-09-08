import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { gateHome } from "@/lib/def-root";

import { withSkillName } from "./loader";
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

/** What a spawned Claude Code is told about the plugin it has been handed. */
export function skillsDirective(skills: SkillDefinition[]): string {
  const list = skills.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  return (
    `You have been given these skills, and this node is expected to be done the way they say:\n${list}\n\n` +
    `Read each one before you start — they are available as skills in this session — and follow it. ` +
    `A skill that describes a process is the process for this node, not background reading.`
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
        name: "gate-skills",
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
      filter: (src) => basename(src) !== ".gate-source.json",
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
