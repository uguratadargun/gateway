import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { backupStamp, refreshDefaultAgents, retireDefaultAgents, staleDefaultAgents, writeMissingDefaultAgents } from "@/agents/defaults";
import { DEFAULT_TEAM, gateHome, teamScope } from "@/lib/def-root";
import {
  refreshDefaultWorkflows,
  retireDefaultWorkflows,
  staleDefaultWorkflows,
  writeMissingDefaultWorkflows,
} from "@/workflows/defaults";

/**
 * Puts the shipped agents and pipeline back, from the command line.
 *
 * The same thing the Restore button on /agents does, for when the dashboard
 * is not the tool at hand — a fresh server, a team that deleted everything, a
 * gate updated past the version that seeded it. Files are written straight
 * into ~/.gate/teams/<team>, which the server reads on every request, so a
 * running gate sees them at once and no restart is needed.
 *
 * Nothing is overwritten unless asked: an id a team already has, edited or
 * not, is left as it is, and named if it differs from what ships — a gate
 * update that changed a definition leaves the old file behind, and a pipeline
 * whose implementer asks for an output the new planner no longer produces
 * fails at that node with nothing else to say. `--refresh` rewrites those to
 * the shipped text, keeping the model and effort set on them, with the old
 * text under <team>/backups/<stamp>/, and puts aside the definitions gate no
 * longer ships (`dev-super` and the `super-*` agents) the same way. "Has" includes what a team inherits
 * from the default team, so restoring the default team is usually the whole
 * of it — every other team reaches those files through it, and gets no copy
 * of its own.
 *
 *   npm run defaults:restore                 the default team
 *   npm run defaults:restore -- --team ulak  one team
 *   npm run defaults:restore -- --all        every team directory under ~/.gate/teams
 *   npm run defaults:restore -- --refresh    also rewrite shipped definitions that differ
 */

function teamsOnDisk(): string[] {
  const dir = join(gateHome(), "teams");
  if (!existsSync(dir)) return [DEFAULT_TEAM];
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  // The default team first: once it has the files, the others inherit them
  // and are written nothing.
  return [DEFAULT_TEAM, ...ids.filter((id) => id !== DEFAULT_TEAM).sort()];
}

function parseArgs(argv: string[]): { teams: string[]; refresh: boolean } {
  const teams: string[] = [];
  let all = false;
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      all = true;
      continue;
    }
    if (a === "--refresh") {
      refresh = true;
      continue;
    }
    if (a === "--team") {
      const id = argv[++i];
      if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        console.error("--team needs a team id: lowercase letters, digits and dashes");
        process.exit(2);
      }
      teams.push(id);
      continue;
    }
    console.error(`unknown argument: ${a}\nusage: defaults:restore [--team <id>] [--all] [--refresh]`);
    process.exit(2);
  }
  return { teams: all ? teamsOnDisk() : teams.length ? teams : [DEFAULT_TEAM], refresh };
}

const { teams, refresh } = parseArgs(process.argv.slice(2));
const stamp = backupStamp();
for (const team of teams) {
  const scope = teamScope(team);
  // Agents first: a workflow naming one that is not there yet would not load.
  const added = [...writeMissingDefaultAgents(scope), ...writeMissingDefaultWorkflows(scope)];
  if (refresh) {
    const refreshed = [...refreshDefaultAgents(scope, stamp), ...refreshDefaultWorkflows(scope, stamp)];
    if (refreshed.length) {
      console.log(`${team}: rewrote ${refreshed.join(", ")} to what ships; the old text is under ${join(scope.root, "backups", stamp)}`);
    }
    // Workflows first: a pipeline naming an agent that is gone does not load.
    const retired = [...retireDefaultWorkflows(scope, stamp), ...retireDefaultAgents(scope, stamp)];
    if (retired.length) {
      console.log(`${team}: put aside ${retired.join(", ")}, which gate no longer ships, under ${join(scope.root, "backups", stamp)}`);
    }
  } else {
    const stale = [...staleDefaultAgents(scope), ...staleDefaultWorkflows(scope)];
    if (stale.length) {
      console.log(
        `${team}: ${stale.join(", ")} differ from what ships — edited, or left behind by an update.` +
          ` \`--refresh\` rewrites them (keeping model and effort), with the old text under backups/.`,
      );
    }
  }
  console.log(
    added.length
      ? `${team}: wrote ${added.join(", ")} to ${scope.root}`
      : `${team}: nothing missing — every shipped definition is there or inherited`,
  );
}
