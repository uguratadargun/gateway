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
  return { id: r.id, name: r.name, createdAt: Number(r.created_at) };
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

export function createTeam(name: string, id?: string): Team {
  const teamId = id?.trim() || slugify(name);
  if (!isValidTeamId(teamId)) throw new Error("invalid team id (use lowercase letters, digits and dashes)");
  if (getTeam(teamId)) throw new Error(`team "${teamId}" already exists`);
  getDb().prepare("INSERT INTO teams (id, name, created_at) VALUES (?,?,?)").run(teamId, name.trim() || teamId, Date.now());
  return getTeam(teamId)!;
}

/**
 * Removing a team leaves its definition directory alone: the files are the
 * deliverable of whoever wrote them, and a delete in the dashboard should not
 * quietly destroy work. Its users and keys go with it.
 */
export function deleteTeam(id: string): boolean {
  if (id === DEFAULT_TEAM_ID) throw new Error("the default team cannot be deleted");
  const db = getDb();
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
