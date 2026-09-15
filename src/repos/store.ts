import { getDb } from "@/lib/db";

import { canonicalRepoId } from "./identity";

/**
 * Repositories gate knows how to work in.
 *
 * A run's worktree has to branch from a checkout that exists and has had its
 * dependencies fetched. Before this, that was a path typed into a run input
 * and a set of command nodes copied into every workflow that touched the same
 * project. Registering it once puts the path, the install and the per-worktree
 * preparation in one place, and makes "which repo" a choice from a list rather
 * than a string nobody validates until the run fails.
 */

export type RepoStatus = "new" | "installing" | "ready" | "failed";

export interface RepoRecord {
  id: string;
  name: string;
  /** What was given: a local path, or the git URL gate cloned from. */
  source: string;
  /** What the checkout's own origin says, or null when it has no remote. */
  remoteUrl: string | null;
  /**
   * `host/owner/name` — the one name every clone of this repository agrees
   * on. Null means unknown, and unknown is never filled in from the path or
   * the slug: two teams' repositories are routinely called the same thing.
   */
  repoId: string | null;
  /** Where the checkout is on disk. */
  root: string;
  /** Whether gate created it, and so may delete it again. */
  cloned: boolean;
  baseRef: string | null;
  /** argv arrays run once in the repo root. */
  setup: string[][];
  /** argv arrays run in each run's worktree. */
  prepare: string[][];
  status: RepoStatus;
  lastSetupAt: number | null;
  lastSetupLog: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  source: string;
  remote_url: string | null;
  repo_id: string | null;
  root: string;
  cloned: number;
  base_ref: string | null;
  setup_json: string;
  prepare_json: string;
  status: string;
  last_setup_at: number | null;
  last_setup_log: string | null;
  created_at: number;
}

function parseArgv(json: string): string[][] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[][]).filter((c) => Array.isArray(c) && c.length) : [];
  } catch {
    return [];
  }
}

function toRecord(r: Row): RepoRecord {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    remoteUrl: r.remote_url ?? null,
    repoId: r.repo_id ?? null,
    root: r.root,
    cloned: r.cloned === 1,
    baseRef: r.base_ref,
    setup: parseArgv(r.setup_json),
    prepare: parseArgv(r.prepare_json),
    status: (["new", "installing", "ready", "failed"] as const).includes(r.status as RepoStatus)
      ? (r.status as RepoStatus)
      : "new",
    lastSetupAt: r.last_setup_at,
    lastSetupLog: r.last_setup_log,
    createdAt: r.created_at,
  };
}

export function listRepos(): RepoRecord[] {
  return (getDb().prepare("SELECT * FROM repos ORDER BY created_at DESC").all() as unknown as Row[]).map(toRecord);
}

export function getRepo(id: string): RepoRecord | null {
  const r = getDb().prepare("SELECT * FROM repos WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toRecord(r) : null;
}

export interface NewRepo {
  id: string;
  name: string;
  source: string;
  root: string;
  cloned: boolean;
  baseRef: string | null;
  setup: string[][];
  prepare: string[][];
  remoteUrl?: string | null;
}

export function createRepo(repo: NewRepo): RepoRecord {
  getDb()
    .prepare(
      `INSERT INTO repos (id, name, source, remote_url, repo_id, root, cloned, base_ref, setup_json, prepare_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    )
    .run(
      repo.id,
      repo.name,
      repo.source,
      repo.remoteUrl ?? null,
      // The identity comes from the remote and only from the remote, so a
      // repo registered by path stays unknown until a remote is read off it.
      repo.remoteUrl ? canonicalRepoId(repo.remoteUrl) : null,
      repo.root,
      repo.cloned ? 1 : 0,
      repo.baseRef,
      JSON.stringify(repo.setup),
      JSON.stringify(repo.prepare),
      Date.now(),
    );
  return getRepo(repo.id)!;
}

export function updateRepo(
  id: string,
  patch: Partial<Pick<RepoRecord, "name" | "baseRef" | "setup" | "prepare">>,
): RepoRecord | null {
  const current = getRepo(id);
  if (!current) return null;
  getDb()
    .prepare("UPDATE repos SET name = ?, base_ref = ?, setup_json = ?, prepare_json = ? WHERE id = ?")
    .run(
      patch.name ?? current.name,
      patch.baseRef !== undefined ? patch.baseRef : current.baseRef,
      JSON.stringify(patch.setup ?? current.setup),
      JSON.stringify(patch.prepare ?? current.prepare),
      id,
    );
  return getRepo(id);
}

/**
 * Records what the checkout's origin says, and the identity that follows.
 *
 * Refuses to move an identity that is already set. A repository whose origin
 * suddenly names a different one is not the same repository, and everything
 * already written under the old identity — decisions, touches, objections —
 * would quietly come to mean something else. The caller is told which two
 * identities disagree and decides; gate does not pick for them.
 */
export function setRepoRemote(
  id: string,
  remoteUrl: string | null,
): { ok: true; repo: RepoRecord } | { ok: false; was: string; now: string } {
  const current = getRepo(id);
  if (!current) return { ok: true, repo: current as unknown as RepoRecord };
  const next = remoteUrl ? canonicalRepoId(remoteUrl) : null;
  // Losing a remote does not revoke an identity: a checkout that has gone
  // offline is still the same repository, and the memory under it still is.
  if (current.repoId && next && next !== current.repoId) {
    return { ok: false, was: current.repoId, now: next };
  }
  getDb()
    .prepare("UPDATE repos SET remote_url = ?, repo_id = ? WHERE id = ?")
    .run(remoteUrl, next ?? current.repoId, id);
  return { ok: true, repo: getRepo(id)! };
}

/** The registered repo with this identity, if gate knows one. */
export function repoByIdentity(repoId: string): RepoRecord | null {
  const r = getDb().prepare("SELECT * FROM repos WHERE repo_id = ?").get(repoId) as unknown as Row | undefined;
  return r ? toRecord(r) : null;
}

export function setRepoStatus(id: string, status: RepoStatus, log?: string): void {
  getDb()
    .prepare("UPDATE repos SET status = ?, last_setup_at = ?, last_setup_log = ? WHERE id = ?")
    .run(status, Date.now(), log ?? null, id);
}

export function deleteRepo(id: string): boolean {
  return getDb().prepare("DELETE FROM repos WHERE id = ?").run(id).changes > 0;
}
