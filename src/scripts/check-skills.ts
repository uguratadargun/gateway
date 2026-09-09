import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_AGENT_SKILLS, SKILL_ANCHORS } from "@/agents/defaults";
import { DEFAULT_TEAM, gateHome, teamScope } from "@/lib/def-root";
import { resolveSkillDir } from "@/skills/registry";

/**
 * Checks that the skills on this machine still say what the shipped prompts
 * rely on them saying.
 *
 * The planner is told to do "Step 2 and Step 3" of its worktree skill; the
 * implementer that its ledger lives at `.superpowers/sdd/`; the reviewer that
 * a `code-reviewer.md` template exists. Those are facts about one version of
 * the library, and a Sync that moves past that version breaks the prompts
 * silently — the model follows text that is no longer there and improvises.
 * `SKILL_ANCHORS` lists what each prompt leans on; this reads the skill as
 * the team has it and names what is missing, so the prompts can be re-read
 * before a run finds out.
 *
 *   npm run skills:check                 the default team's library
 *   npm run skills:check -- --team ulak  one team's, inheritance included
 *   npm run skills:check -- --source     the synced clone, ahead of importing
 */

const args = process.argv.slice(2);
const teamFlag = args.indexOf("--team");
const team = teamFlag >= 0 ? args[teamFlag + 1] : DEFAULT_TEAM;
const fromSource = args.includes("--source");

function skillFile(id: string): string | null {
  if (fromSource) {
    const entry = DEFAULT_AGENT_SKILLS.find((s) => s.id === id);
    if (!entry) return null;
    const file = join(gateHome(), "skill-sources", entry.source, "skills", entry.sourceSkill, "SKILL.md");
    return existsSync(file) ? file : null;
  }
  const dir = resolveSkillDir(id, teamScope(team));
  return dir ? join(dir, "SKILL.md") : null;
}

/** What is missing, per skill; a skill that is not there at all is reported as such. */
export function checkAnchors(read: (id: string) => string | null = (id) => {
  const file = skillFile(id);
  return file ? readFileSync(file, "utf8") : null;
}): Array<{ skill: string; missing: string[] | null }> {
  const out: Array<{ skill: string; missing: string[] | null }> = [];
  for (const { skill, anchors } of SKILL_ANCHORS) {
    const text = read(skill);
    if (text === null) {
      out.push({ skill, missing: null });
      continue;
    }
    const missing = anchors.filter((a) => !text.includes(a));
    if (missing.length) out.push({ skill, missing });
  }
  return out;
}

const problems = checkAnchors();
const where = fromSource ? "the synced clone" : `team ${team}'s library`;
if (!problems.length) {
  console.log(`every anchor the shipped prompts rely on is present in ${where} (${SKILL_ANCHORS.length} skills checked)`);
  process.exit(0);
}
console.error(`in ${where}:`);
for (const p of problems) {
  if (p.missing === null) console.error(`  ${p.skill}: not there — import it from the Skills page`);
  else console.error(`  ${p.skill}: no longer says ${p.missing.map((m) => JSON.stringify(m)).join(", ")}`);
}
console.error("Re-read the prompt that leans on each one (src/agents/defaults.ts) before running against this version.");
process.exit(1);
