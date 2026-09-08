import { z } from "zod";

/**
 * A skill is a directory: `<scope>/skills/<id>/SKILL.md`, plus whatever files
 * that skill's prose points at, beside it.
 *
 * A directory and not a single file, because that is the shape skills are
 * already written in everywhere else — Claude Code's own, and the published
 * libraries people want to borrow. Keeping the layout identical is what makes
 * `superpowers`' brainstorming skill usable here without being rewritten, and
 * what lets gate hand a skill to a spawned Claude Code as a plugin rather than
 * as a paraphrase of one.
 *
 * The frontmatter is deliberately open: `name` and `description` are the two
 * fields gate reads, and every other key an upstream file carries is kept
 * rather than rejected. An imported library that gains a field must not stop
 * parsing here — that is a sync that fails for no reason a person can act on.
 */

export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(100),
    /**
     * What this skill is for, in one line. It is not decoration: it is the
     * whole of how a model decides to reach for the skill, so a description
     * that says "helps with planning" is a skill that never fires.
     */
    description: z.string().min(1).max(2000),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/** Where an imported skill came from, so "is this still current" has an answer. */
export interface SkillOrigin {
  /** The registered source it was imported from. */
  sourceId: string;
  /** The directory it has in that repository, which need not be its id here. */
  sourceSkill: string;
  /** The commit the clone was on at import time; null when it could not be read. */
  commit: string | null;
  importedAt: number;
  /** sha256 of SKILL.md as imported — a local edit shows up as a mismatch. */
  sha: string;
}

export interface SkillDefinition extends SkillFrontmatter {
  /** Directory basename; how an agent references the skill. */
  id: string;
  /** The Markdown below the frontmatter — what an agent is actually told. */
  body: string;
  /** Files beside SKILL.md, relative to the skill directory. */
  resources: string[];
  /** The skill's directory. */
  dir: string;
  sourcePath: string;
  updatedAt: number;
  /** Null for a skill written here rather than imported. */
  origin: SkillOrigin | null;
}

/** The subset an agent editor or a list needs; the body is the expensive part. */
export type SkillSummary = Omit<SkillDefinition, "body">;

export function skillSummary(skill: SkillDefinition): SkillSummary {
  const { body: _body, ...rest } = skill;
  return rest;
}
