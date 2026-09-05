import { load as parseYaml } from "js-yaml";

import { isKnownTool, knownToolNames } from "@/runtime/tools/registry";

import { templatePaths } from "./template";
import { agentFrontmatterSchema, type AgentDefinition } from "./types";

/** Parsing and validation of agent Markdown files. No filesystem access here. */

export class AgentDefinitionError extends Error {
  constructor(message: string, readonly agentId: string) {
    super(message);
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse an agent file. `id` is the file basename; `sourcePath` and `updatedAt`
 * are recorded for the editor UI.
 */
export function parseAgent(
  id: string,
  raw: string,
  meta: { sourcePath: string; updatedAt: number },
): AgentDefinition {
  const m = FRONTMATTER.exec(raw.replace(/^﻿/, ""));
  if (!m) throw new AgentDefinitionError("missing YAML frontmatter (a file must start with a --- block)", id);

  let front: unknown;
  try {
    front = parseYaml(m[1]) ?? {};
  } catch (e) {
    throw new AgentDefinitionError(`invalid YAML frontmatter: ${(e as Error).message}`, id);
  }

  const parsed = agentFrontmatterSchema.safeParse(front);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new AgentDefinitionError(`invalid frontmatter: ${detail}`, id);
  }

  const prompt = m[2].trim();
  if (!prompt) throw new AgentDefinitionError("prompt body is empty", id);

  const def: AgentDefinition = { ...parsed.data, id, prompt, sourcePath: meta.sourcePath, updatedAt: meta.updatedAt };
  const unknownTools = def.tools.filter((t) => !isKnownTool(t));
  if (unknownTools.length) {
    throw new AgentDefinitionError(
      `unknown tool${unknownTools.length > 1 ? "s" : ""}: ${unknownTools.join(", ")} (available: ${knownToolNames().join(", ")})`,
      id,
    );
  }
  assertTemplateInputsDeclared(def);
  return def;
}

/**
 * Every `{{inputs.x}}` the prompt reads must be a declared input: the runtime
 * only ever hands an agent what it declared, so an undeclared reference would
 * fail at request time instead of at authoring time.
 */
function assertTemplateInputsDeclared(def: AgentDefinition): void {
  // A trailing "?" marks an input optional at resolve time; it is not part of
  // the path a template references.
  const declared = new Set(def.inputs.map((i) => i.replace(/\?$/, "")));
  const undeclared = templatePaths(def.prompt)
    .filter((p) => p.startsWith("inputs."))
    .map((p) => p.slice("inputs.".length))
    .filter((p) => ![...declared].some((d) => p === d || p.startsWith(`${d}.`) || d.startsWith(`${p}.`)));
  if (undeclared.length) {
    throw new AgentDefinitionError(
      `prompt references undeclared input${undeclared.length > 1 ? "s" : ""}: ${[...new Set(undeclared)].join(", ")}`,
      def.id,
    );
  }
}

/** Serialize a definition back to Markdown (used when the UI saves an edit). */
export function serializeAgent(front: Record<string, unknown>, prompt: string): string {
  const yaml = Object.entries(front)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${prompt.trim()}\n`;
}
