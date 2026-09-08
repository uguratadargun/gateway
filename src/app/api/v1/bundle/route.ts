import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { ensureDefaultWorkflows } from "@/workflows/defaults";
import { inheritedAgents, listAgents, readAgentSource } from "@/agents/registry";
import { getAgent } from "@/agents/registry";
import { requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { requiredRunInputs } from "@/workflows/inputs";
import { inheritedSkills, listSkills } from "@/skills/registry";
import type { SkillDefinition } from "@/skills/types";
import { inheritedWorkflows, listWorkflows, readWorkflowSource } from "@/workflows/registry";

export const runtime = "nodejs";

function sha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/**
 * A skill is a directory, so it travels as its files rather than as one
 * source string.
 *
 * Base64 and not text: a skill may legitimately ship an image or a compiled
 * helper beside its prose, and a mirror that quietly corrupted those would
 * produce a skill that reads correctly and does not work. Anything past the
 * cap is left out and named, because a skill missing a file it points at
 * should say so here rather than confuse an agent later.
 */
const MAX_SKILL_FILE_BYTES = 512 * 1024;

function bundleSkill(skill: SkillDefinition): {
  packed: { id: string; name: string; files: Array<{ path: string; base64: string }>; sha: string };
  skipped: string[];
} {
  const files: Array<{ path: string; base64: string }> = [];
  const skipped: string[] = [];
  for (const rel of ["SKILL.md", ...skill.resources]) {
    const full = join(skill.dir, rel);
    try {
      if (statSync(full).size > MAX_SKILL_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      files.push({ path: rel, base64: readFileSync(full).toString("base64") });
    } catch {
      skipped.push(rel);
    }
  }
  const digest = createHash("sha256");
  for (const f of files) digest.update(`${f.path}:${f.base64}`);
  return { packed: { id: skill.id, name: skill.name, files, sha: digest.digest("hex").slice(0, 16) }, skipped };
}

/**
 * Everything a client needs to run this team's pipelines on its own machine:
 * the agent and workflow *sources*, not a parsed form. The client parses them
 * with the same loader the server does, so a definition means one thing
 * wherever it runs, and a file that fails validation fails identically.
 *
 * The bundle carries a hash of itself. `gate pull` sends it back as
 * `If-None-Match`, so an unchanged team costs one 304 rather than a copy of
 * every file — and the same hash is what the client records when the user
 * approves what a workflow is allowed to run on their machine.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;
  const scope = scopeForPrincipal(auth);

  // A team that has never been opened has no files yet; seed it the same way
  // the dashboard does on first visit.
  ensureDefaultWorkflows(scope);

  // Own first, then what the team inherits from the default team's library.
  // The client writes them into one directory, which is the right shape there:
  // a machine running a pipeline does not care whose it is, only that the
  // agents it names resolve — and by this point they do.
  const agents = [...listAgents(scope).agents, ...inheritedAgents(scope)].map((a) => {
    const source = readAgentSource(a.id, scope);
    return { id: a.id, name: a.name, source, sha: sha(source) };
  });

  // Skills ride along for the same reason agents do: a node that names one is
  // a node that cannot run correctly without it, wherever it runs.
  const skillErrors = [...listSkills(scope).errors];
  const skills = [...listSkills(scope).skills, ...inheritedSkills(scope)].map((skill) => {
    const { packed, skipped } = bundleSkill(skill);
    if (skipped.length) {
      skillErrors.push({ id: skill.id, message: `not mirrored (too large or unreadable): ${skipped.join(", ")}` });
    }
    return packed;
  });

  const { workflows: own, errors } = listWorkflows(scope);
  const workflows = [...own, ...inheritedWorkflows(scope)];
  const bundled = workflows.map((wf) => {
    const source = readWorkflowSource(wf.id, scope);
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description ?? null,
      inputs: requiredRunInputs(wf, (id) => getAgent(id, scope)),
      nodeCount: wf.nodes.length,
      workspace: wf.workspace ?? null,
      source,
      sha: sha(source),
    };
  });

  const hash = createHash("sha256")
    .update(
      [
        ...agents.map((a) => `a:${a.id}:${a.sha}`),
        ...skills.map((s) => `s:${s.id}:${s.sha}`),
        ...bundled.map((w) => `w:${w.id}:${w.sha}`).sort(),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

  const etag = `"${hash}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return NextResponse.json(
    { team: auth.teamId, hash, agents, skills, workflows: bundled, errors: [...errors, ...skillErrors] },
    { headers: { ETag: etag } },
  );
}
