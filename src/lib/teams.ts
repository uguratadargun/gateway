import { randomBytes } from "node:crypto";

import { getDb } from "./db";

/**
 * Who uses this gate, and which team's definitions they get.
 *
 * A team is the unit that owns agents and workflows — its files live under
 * ~/.gate/teams/<id>, which is why a team id is a slug and not a UUID: it is a
 * directory name a person reads and edits. A user is a person with one team and
 * one or more API keys; the key is what identifies them to the client API and
 * the gateway.
 *
 * Everything that existed before multi-user belongs to the `default` team, so a
 * single-person install keeps working with no migration to think about.
 */

export const DEFAULT_TEAM_ID = "default";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Team {
  id: string;
  name: string;
  /** The team this one sits under; null for a root. See teamTree below. */
  parentId: string | null;
  createdAt: number;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  teamId: string;
  disabled: boolean;
  createdAt: number;
}

function rowToTeam(r: any): Team {
  return { id: r.id, name: r.name, parentId: r.parent_id ?? null, createdAt: Number(r.created_at) };
}

function rowToUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? null,
    teamId: r.team_id,
    disabled: !!r.disabled,
    createdAt: Number(r.created_at),
  };
}

/** A directory-safe id from a display name. Falls back to a random suffix. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return SLUG_RE.test(base) ? base : `team-${randomBytes(3).toString("hex")}`;
}

export function isValidTeamId(id: string): boolean {
  return SLUG_RE.test(id);
}

/**
 * The team every pre-multi-user install already had. Created on first read so
 * no startup hook has to know about it.
 */
export function ensureDefaultTeam(): Team {
  const existing = getTeam(DEFAULT_TEAM_ID);
  if (existing) return existing;
  getDb()
    .prepare("INSERT OR IGNORE INTO teams (id, name, created_at) VALUES (?,?,?)")
    .run(DEFAULT_TEAM_ID, "Default", Date.now());
  return getTeam(DEFAULT_TEAM_ID)!;
}

export function listTeams(): Team[] {
  ensureDefaultTeam();
  return (getDb().prepare("SELECT * FROM teams ORDER BY created_at ASC").all() as any[]).map(rowToTeam);
}

export function getTeam(id: string): Team | null {
  const row = getDb().prepare("SELECT * FROM teams WHERE id = ?").get(id);
  return row ? rowToTeam(row) : null;
}

export function createTeam(name: string, id?: string, parentId?: string | null): Team {
  const teamId = id?.trim() || slugify(name);
  if (!isValidTeamId(teamId)) throw new Error("invalid team id (use lowercase letters, digits and dashes)");
  if (getTeam(teamId)) throw new Error(`team "${teamId}" already exists`);
  const parent = parentId?.trim() || null;
  if (parent && !getTeam(parent)) throw new Error(`no team "${parent}" to sit under`);
  getDb()
    .prepare("INSERT INTO teams (id, name, parent_id, created_at) VALUES (?,?,?,?)")
    .run(teamId, name.trim() || teamId, parent, Date.now());
  return getTeam(teamId)!;
}

/**
 * Moves a team under another, or to the root with null.
 *
 * A team may not be put under itself or under one of its own descendants:
 * the tree is what memory visibility is computed from, and a cycle would
 * make every team in it see everything, or nothing, depending on where the
 * walk happened to start.
 */
export function setTeamParent(id: string, parentId: string | null): Team {
  const team = getTeam(id);
  if (!team) throw new Error(`no team "${id}"`);
  const parent = parentId?.trim() || null;
  if (parent) {
    if (parent === id) throw new Error("a team cannot sit under itself");
    if (!getTeam(parent)) throw new Error(`no team "${parent}" to sit under`);
    if (teamTree(id).includes(parent)) throw new Error(`"${parent}" is under "${id}" already; that would be a loop`);
  }
  getDb().prepare("UPDATE teams SET parent_id = ? WHERE id = ?").run(parent, id);
  return getTeam(id)!;
}

/** The team itself, then its parent, and so on up to the root. */
export function teamAncestors(id: string): Team[] {
  const out: Team[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const team: Team | null = getTeam(cursor);
    if (!team) break;
    out.push(team);
    cursor = team.parentId;
  }
  return out;
}

/** The root of the tree a team is in — the team itself when it has no parent. */
export function teamRoot(id: string): string {
  const chain = teamAncestors(id);
  return chain.length ? chain[chain.length - 1].id : id;
}

/**
 * Every team id in the subtree under `id`, the team itself first.
 *
 * Teams are few — one row per group of people — so this walks the table in
 * memory rather than with a recursive query; the result is what a memory
 * search is scoped to.
 */
export function teamTree(id: string): string[] {
  const all = getDb().prepare("SELECT id, parent_id FROM teams").all() as Array<{ id: string; parent_id: string | null }>;
  const children = new Map<string, string[]>();
  for (const t of all) {
    if (!t.parent_id) continue;
    children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

/**
 * The whole tree a team belongs to: its root and everything under it. This is
 * the boundary of what its runs may read from memory — a sibling's feature
 * record is in reach, a different company's on the same gate is not.
 */
export function teamFamily(id: string): string[] {
  return teamTree(teamRoot(id));
}

/** "ulak/android": the team's ancestry as a path, root first. */
export function teamPath(id: string): string {
  return teamAncestors(id)
    .map((t) => t.id)
    .reverse()
    .join("/");
}

/**
 * Removing a team leaves its definition directory alone: the files are the
 * deliverable of whoever wrote them, and a delete in the dashboard should not
 * quietly destroy work. Its users and keys go with it.
 */
export function deleteTeam(id: string): boolean {
  if (id === DEFAULT_TEAM_ID) throw new Error("the default team cannot be deleted");
  const db = getDb();
  // A team with teams under it is a tree, and the ones below would be left
  // pointing at nothing; move or delete them first.
  const below = teamTree(id).filter((t) => t !== id);
  if (below.length) throw new Error(`"${id}" has ${below.join(", ")} under it; move or delete them first`);
  db.prepare("DELETE FROM apikeys WHERE team_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE team_id = ?").run(id);
  return Number(db.prepare("DELETE FROM teams WHERE id = ?").run(id).changes) > 0;
}

export function listUsers(teamId?: string): User[] {
  const db = getDb();
  const rows = teamId
    ? db.prepare("SELECT * FROM users WHERE team_id = ? ORDER BY created_at ASC").all(teamId)
    : db.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
  return (rows as any[]).map(rowToUser);
}

export function getUser(id: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row) : null;
}

export function getUserByEmail(email: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
  return row ? rowToUser(row) : null;
}

export function createUser(input: { email: string; name?: string; teamId: string }): User {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("a user needs an email address");
  if (getUserByEmail(email)) throw new Error(`${email} already has an account`);
  if (!getTeam(input.teamId)) throw new Error(`no team "${input.teamId}"`);
  const id = randomBytes(8).toString("hex");
  getDb()
    .prepare("INSERT INTO users (id, email, name, team_id, disabled, created_at) VALUES (?,?,?,?,0,?)")
    .run(id, email, input.name?.trim() || null, input.teamId, Date.now());
  return getUser(id)!;
}

export function updateUser(id: string, patch: { name?: string; teamId?: string; disabled?: boolean }): User | null {
  const user = getUser(id);
  if (!user) return null;
  if (patch.teamId && !getTeam(patch.teamId)) throw new Error(`no team "${patch.teamId}"`);
  const next = {
    name: patch.name === undefined ? user.name : patch.name.trim() || null,
    teamId: patch.teamId ?? user.teamId,
    disabled: patch.disabled === undefined ? user.disabled : patch.disabled,
  };
  const db = getDb();
  db.prepare("UPDATE users SET name = ?, team_id = ?, disabled = ? WHERE id = ?").run(
    next.name,
    next.teamId,
    next.disabled ? 1 : 0,
    id,
  );
  // A key follows its owner: moving someone to another team must not leave
  // their key pointed at the definitions they can no longer see.
  if (next.teamId !== user.teamId) db.prepare("UPDATE apikeys SET team_id = ? WHERE user_id = ?").run(next.teamId, id);
  return getUser(id);
}

/** Deleting a person revokes what they could connect with, in one step. */
export function deleteUser(id: string): boolean {
  const db = getDb();
  db.prepare("UPDATE apikeys SET revoked = 1 WHERE user_id = ?").run(id);
  return Number(db.prepare("DELETE FROM users WHERE id = ?").run(id).changes) > 0;
}
