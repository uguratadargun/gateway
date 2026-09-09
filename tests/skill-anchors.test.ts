import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { load as parseYaml } from "js-yaml";

import { DEFAULT_AGENT_SKILLS, DEFAULT_AGENTS, SKILL_ANCHORS } from "@/agents/defaults";

/**
 * The shipped prompts lean on what the superpowers skills say — step numbers,
 * paths, section names. This holds those anchors against the library as it
 * is cloned on this machine, so a sync that moved past the text the prompts
 * were written for fails here, with the skill and the phrase named, rather
 * than in a run. Skipped where the clone is not there: a CI box has none,
 * and the anchors themselves are still checked for shape.
 */

const clone = join(process.env.GATE_SKILL_SOURCE ?? join(homedir(), ".gate", "skill-sources", "superpowers"), "skills");

describe("what the prompts rely on the skills saying", () => {
  it("names only skills the shipped agents declare, and every agent's skill has anchors or is a gate to the person", () => {
    const declared = new Set(DEFAULT_AGENT_SKILLS.map((s) => s.id));
    for (const { skill, anchors } of SKILL_ANCHORS) {
      expect(declared.has(skill), `${skill} is anchored but not a shipped skill`).toBe(true);
      expect(anchors.length).toBeGreaterThan(0);
    }
    // Every skill a shipped agent names is one gate ships the import for.
    for (const [id, source] of Object.entries(DEFAULT_AGENTS)) {
      const front = parseYaml(source.split("---")[1]) as { skills?: string[] };
      for (const skill of front.skills ?? []) expect(declared.has(skill), `${id} names ${skill}`).toBe(true);
    }
  });

  it.skipIf(!existsSync(clone))("are all present in the superpowers clone on this machine", () => {
    const bySkill = new Map(DEFAULT_AGENT_SKILLS.map((s) => [s.id, s.sourceSkill]));
    const missing: string[] = [];
    for (const { skill, anchors } of SKILL_ANCHORS) {
      const file = join(clone, bySkill.get(skill) ?? skill, "SKILL.md");
      if (!existsSync(file)) {
        missing.push(`${skill}: no SKILL.md at ${file}`);
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const anchor of anchors) if (!text.includes(anchor)) missing.push(`${skill}: no longer says ${JSON.stringify(anchor)}`);
    }
    expect(missing, "re-read the prompt that leans on each of these in src/agents/defaults.ts").toEqual([]);
  });
});
