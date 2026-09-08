"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";

/**
 * Which team's definitions a page is showing.
 *
 * Agents and workflows belong to a team, and until there was a way to say
 * which one, every page silently meant `default` — so a team's own pipelines
 * were unreachable from the dashboard that is supposed to own them, and moving
 * one meant moving files by hand.
 *
 * The choice sticks across pages (a list, a definition, back to the list) and
 * rides in the URL so a link to someone else's team is a link, not a
 * screenshot. It is read from `window.location` rather than `useSearchParams`
 * on purpose: these pages are statically prerendered, and the hook would need
 * a Suspense boundary around each of them to build.
 */

export const DEFAULT_TEAM = "default";
const STORAGE_KEY = "gate.team";

export interface TeamOption {
  id: string;
  name: string;
}

/** Appends the team to an API path. The default team is the bare path. */
export function withTeam(path: string, team: string): string {
  if (!team || team === DEFAULT_TEAM) return path;
  return `${path}${path.includes("?") ? "&" : "?"}team=${encodeURIComponent(team)}`;
}

export function useTeamScope(): {
  team: string;
  setTeam: (id: string) => void;
  teams: TeamOption[];
  /** True once the URL and storage have been read; fetches wait for it. */
  ready: boolean;
} {
  const [team, setTeamState] = useState(DEFAULT_TEAM);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("team");
    const remembered = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    setTeamState(fromUrl || remembered || DEFAULT_TEAM);
    setReady(true);
  }, []);

  useEffect(() => {
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d) => setTeams(d.teams ?? []))
      .catch(() => setTeams([]));
  }, []);

  const setTeam = useCallback((id: string) => {
    setTeamState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // A browser that refuses storage still gets the URL.
    }
    const url = new URL(window.location.href);
    if (id === DEFAULT_TEAM) url.searchParams.delete("team");
    else url.searchParams.set("team", id);
    window.history.replaceState(null, "", url.toString());
  }, []);

  return { team, setTeam, teams, ready };
}

/** The switcher. Hidden while there is only one team — then there is no choice. */
export function TeamPicker({
  team,
  teams,
  onChange,
}: {
  team: string;
  teams: TeamOption[];
  onChange: (id: string) => void;
}) {
  if (teams.length < 2) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Users className="size-3.5" />
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        value={team}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Team"
      >
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Moves the selected rows to another team, one at a time, reporting what
 * refused rather than failing the batch on the first one — a workflow that
 * cannot move because its agents are still behind should not stop the agents
 * from moving.
 */
export async function moveMany(
  path: (id: string) => string,
  ids: string[],
  to: string,
): Promise<Array<{ id: string; error: string }>> {
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      const res = await fetch(path(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      if (!res.ok) failed.push({ id, error: (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}` });
    } catch (e) {
      failed.push({ id, error: (e as Error).message });
    }
  }
  return failed;
}
