import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a set of agent and workflow definitions lives.
 *
 * There used to be exactly one answer — ~/.gate/agents and ~/.gate/workflows —
 * because there was one person. With teams there is one directory per team, and
 * with runs happening on developers' own machines there is a third kind of root
 * entirely: the read-only cache the client CLI pulls into. All three are the
 * same shape, so the registries take a scope instead of knowing the path.
 */

export interface DefinitionScope {
  /** Absolute directory holding `agents/` and `workflows/`. */
  root: string;
  /** The team these definitions belong to; absent for a client-side cache. */
  teamId?: string;
  /**
   * Where else to look for a definition this scope does not have.
   *
   * The default team is the house library: agents and pipelines every team can
   * use, written once. A team's own copy of a name always wins — that is what
   * makes borrowing safe, because a team can replace anything it inherits
   * without asking anyone — and nothing here can write to the fallback, so
   * "whose is this" has one answer.
   */
  fallback?: DefinitionScope;
}

export const DEFAULT_TEAM = "default";

export function gateHome(): string {
  return process.env.GATE_HOME || join(homedir(), ".gate");
}

/** A team's definitions on the server, plus what it inherits from the default team. */
export function teamScope(teamId: string = DEFAULT_TEAM): DefinitionScope {
  migrateLegacyDefinitions();
  const root = join(gateHome(), "teams", teamId);
  if (teamId === DEFAULT_TEAM) return { root, teamId };
  return { root, teamId, fallback: { root: join(gateHome(), "teams", DEFAULT_TEAM), teamId: DEFAULT_TEAM } };
}

/** The same team, without what it inherits — what it owns, and may edit. */
export function ownScope(scope: DefinitionScope): DefinitionScope {
  return { root: scope.root, teamId: scope.teamId };
}

/** Any directory holding `agents/` and `workflows/` — the client cache uses this. */
export function scopeAt(root: string, teamId?: string): DefinitionScope {
  return { root, teamId };
}

const g = globalThis as unknown as { __gateDefinitionsMigrated?: string };

/**
 * Moves a pre-teams install's definitions under the default team, once.
 *
 * Renamed rather than copied: two directories holding the same agents, one of
 * them silently ignored, is worse than either arrangement on its own. Keyed by
 * GATE_HOME because the tests point it at a fresh directory per case.
 */
export function migrateLegacyDefinitions(): void {
  const home = gateHome();
  if (g.__gateDefinitionsMigrated === home) return;
  g.__gateDefinitionsMigrated = home;
  const target = join(home, "teams", DEFAULT_TEAM);
  for (const kind of ["agents", "workflows"]) {
    const legacy = join(home, kind);
    const next = join(target, kind);
    if (!existsSync(legacy) || existsSync(next)) continue;
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      renameSync(legacy, next);
    } catch {
      // A move that cannot happen (permissions, a mount boundary) leaves the
      // old directory where it is; the team simply starts empty and is seeded.
    }
  }
}

/**
 * The team a management request is about: `?team=<id>`, defaulting to the team
 * a single-person install has always had. Unknown or malformed ids fall back
 * rather than 404ing, so a stale dashboard tab cannot wedge the editor.
 */
export function scopeFromRequest(req: Request, teamExists: (id: string) => boolean): DefinitionScope {
  const asked = new URL(req.url).searchParams.get("team")?.trim();
  if (asked && /^[a-z0-9][a-z0-9-]{0,63}$/.test(asked) && teamExists(asked)) return teamScope(asked);
  return teamScope();
}
