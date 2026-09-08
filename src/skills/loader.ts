import { createHash } from "node:crypto";

import { dump as dumpYaml, load as parseYaml } from "js-yaml";

import { skillFrontmatterSchema, type SkillDefinition, type SkillOrigin } from "./types";

/** Parsing and validation of SKILL.md. No filesystem access here. */

export class SkillDefinitionError extends Error {
  constructor(message: string, readonly skillId: string) {
    super(message);
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Content hash of a skill's own file, used to spot a local edit after import. */
export function skillSha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export function parseSkill(
  id: string,
  raw: string,
  meta: { dir: string; sourcePath: string; updatedAt: number; resources?: string[]; origin?: SkillOrigin | null },
): SkillDefinition {
  const m = FRONTMATTER.exec(raw.replace(/^﻿/, ""));
  if (!m) throw new SkillDefinitionError("missing YAML frontmatter (SKILL.md must start with a --- block)", id);

  let front: unknown;
  try {
    front = parseYaml(m[1]) ?? {};
  } catch (e) {
    throw new SkillDefinitionError(`invalid YAML frontmatter: ${(e as Error).message}`, id);
  }

  const parsed = skillFrontmatterSchema.safeParse(front);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new SkillDefinitionError(`invalid frontmatter: ${detail}`, id);
  }

  const body = m[2].trim();
  if (!body) throw new SkillDefinitionError("SKILL.md has frontmatter but no body", id);

  return {
    ...parsed.data,
    id,
    body,
    resources: meta.resources ?? [],
    dir: meta.dir,
    sourcePath: meta.sourcePath,
    updatedAt: meta.updatedAt,
    origin: meta.origin ?? null,
  };
}

/**
 * Serialize back to SKILL.md — what the editor saves.
 *
 * `lineWidth: -1` because a description is one long line by nature, and YAML
 * folding it across three is something a person reading the file has to undo
 * in their head every time.
 */
export function serializeSkill(front: Record<string, unknown>, body: string): string {
  const defined = Object.fromEntries(Object.entries(front).filter(([, v]) => v !== undefined));
  const yaml = dumpYaml(defined, { lineWidth: -1, noRefs: true }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/**
 * The same SKILL.md with its `name` forced to `id`, every other key kept.
 *
 * A skill imported under a prefix (`superpowers-brainstorming`) still says
 * `name: brainstorming` inside, and a harness that matches the two would then
 * quietly not load it. Rewriting the one field where the copy is generated —
 * never in the file a person edits — is cheaper than making every import
 * rewrite prose it does not own.
 */
export function withSkillName(raw: string, id: string): string {
  const m = FRONTMATTER.exec(raw.replace(/^﻿/, ""));
  if (!m) return raw;
  const front = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  if (front.name === id) return raw;
  return serializeSkill({ ...front, name: id }, m[2]);
}
