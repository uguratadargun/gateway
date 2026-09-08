import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scopeAt, type DefinitionScope } from "@/lib/def-root";

import type { Bundle, BundleWorkflow } from "./api";
import { gateHome } from "./config";

/**
 * The team's definitions, mirrored onto this machine.
 *
 * A mirror and not a copy to edit: `pull` makes the directory match the server
 * exactly, deleting what the server no longer has. Editing a file here is
 * therefore a change that disappears on the next pull, which is the intended
 * answer — definitions belong to the team and are written in the dashboard.
 *
 * The files are the same Markdown and YAML the server holds, so the same
 * loader parses them and a definition means the same thing on both sides.
 */

export interface Manifest {
  team: string;
  hash: string;
  pulledAt: number;
  from: string;
  workflows: Array<Omit<BundleWorkflow, "source">>;
}

export function cacheDir(team: string): string {
  return join(gateHome(), "cache", team);
}

export function cacheScope(team: string): DefinitionScope {
  return scopeAt(cacheDir(team), team);
}

export function manifestPath(team: string): string {
  return join(cacheDir(team), "manifest.json");
}

export function readManifest(team: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(team), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Replaces the mirror's contents with the bundle's. */
export function writeBundle(bundle: Bundle, from: string): Manifest {
  const root = cacheDir(bundle.team);
  const agents = join(root, "agents");
  const workflows = join(root, "workflows");
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  mkdirSync(workflows, { recursive: true, mode: 0o700 });

  for (const agent of bundle.agents) {
    writeFileSync(join(agents, `${agent.id}.md`), agent.source, { mode: 0o600 });
  }
  for (const workflow of bundle.workflows) {
    writeFileSync(join(workflows, `${workflow.id}.yaml`), workflow.source, { mode: 0o600 });
  }

  // What the server no longer has, this machine no longer has: a workflow
  // deleted by the team must not keep running here because a file stayed
  // behind.
  prune(agents, new Set(bundle.agents.map((a) => `${a.id}.md`)));
  prune(workflows, new Set(bundle.workflows.map((w) => `${w.id}.yaml`)));

  const manifest: Manifest = {
    team: bundle.team,
    hash: bundle.hash,
    pulledAt: Date.now(),
    from,
    workflows: bundle.workflows.map(({ source: _source, ...rest }) => rest),
  };
  writeFileSync(manifestPath(bundle.team), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function prune(dir: string, keep: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!keep.has(entry)) rmSync(join(dir, entry), { force: true });
  }
}
