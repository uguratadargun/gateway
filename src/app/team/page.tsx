"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2, UserPlus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { encodeConnectionToken } from "@/lib/connect-token";

/**
 * Who may connect, and what they connect with.
 *
 * The page is arranged around the thing it exists to produce: a person, and the
 * one command that person runs on their machine. A key is shown once, next to
 * that command, ready to send — because the alternative is a key copied into a
 * chat message and a separate explanation of what to do with it.
 */

interface Team {
  id: string;
  name: string;
  createdAt: number;
  userCount: number;
}

interface User {
  id: string;
  email: string;
  name: string | null;
  teamId: string;
  disabled: boolean;
}

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  userId: string | null;
  teamId: string;
  scopes: string[];
  lastHost: string | null;
}

/**
 * Every management route answers in JSON, so anything else — the dashboard's
 * 404 page, the dev server's error page, the login page after a session has
 * expired — arrives here as markup. Handing that to res.json() raises
 * "Unexpected token '<'", which names neither the call that failed nor the
 * reason; the path and the status do.
 */
async function request(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} answered with a web page, not JSON (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(data?.error ?? `${path} failed (HTTP ${res.status})`);
  return data;
}

export default function TeamPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [teamName, setTeamName] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("default");
  const [issued, setIssued] = useState<{ userId: string; key: string } | null>(null);
  /** Whether the next key issued may write the team's definitions. */
  const [canAuthor, setCanAuthor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, u, k] = await Promise.all([request("/api/teams"), request("/api/users"), request("/api/keys")]);
      setTeams(t.teams ?? []);
      setUsers(u.users ?? []);
      setKeys(k.keys ?? []);
    } catch (e) {
      // A reload that fails silently leaves the page showing nobody, which
      // reads as an empty team rather than as a gate that did not answer.
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: unknown): Promise<any> {
    return request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function addTeam() {
    setError(null);
    try {
      await post("/api/teams", { name: teamName });
      setTeamName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addUser() {
    setError(null);
    try {
      await post("/api/users", { email, name: name || undefined, teamId });
      setEmail("");
      setName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function issueKey(user: User) {
    setError(null);
    try {
      const data = await post("/api/keys", {
        name: `${user.email}`,
        userId: user.id,
        scopes: canAuthor ? ["gateway", "workflows", "author"] : undefined,
      });
      setIssued({ userId: user.id, key: data.plaintext });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await request(`/api/keys/${id}`, { method: "PATCH" });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  }

  /**
   * Moves someone to another team — which moves their keys with them, so the
   * next command they run pulls that team's definitions. Without this, a person
   * created in the wrong team could only be fixed by deleting them.
   */
  async function moveUser(id: string, nextTeam: string) {
    setError(null);
    try {
      await request(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: nextTeam }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeUser(id: string) {
    setError(null);
    try {
      await request(`/api/users/${id}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-sm text-muted-foreground">
          Each person gets a key. They paste one <code>/gate:login</code> line into Claude Code, and their team&apos;s
          workflows run on their own machine — through this gateway.
        </p>
      </div>

      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">{error}</p>}

      <Card className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4" /> Teams
        </div>
        <div className="flex gap-2">
          <Input placeholder="Team name (e.g. Platform)" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
          <Button size="sm" onClick={addTeam} disabled={!teamName.trim()}>
            <Plus /> Add team
          </Button>
        </div>
        <div className="space-y-1">
          {teams.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
              <span className="font-medium">{t.name}</span>
              <code className="text-xs text-muted-foreground">{t.id}</code>
              <span className="ml-auto text-xs text-muted-foreground">
                {t.userCount} {t.userCount === 1 ? "person" : "people"} · agents and workflows in ~/.gate/teams/{t.id}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <UserPlus className="size-4" /> People
          {/* Reading the team's definitions is what everyone needs; writing
              them is a decision about the team's pipelines, so it is asked for
              rather than assumed. */}
          <label className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <input type="checkbox" checked={canAuthor} onChange={(e) => setCanAuthor(e.target.checked)} />
            New keys may author definitions (<code>/gate:design</code>)
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-56 flex-1"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input className="min-w-40 flex-1" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={addUser} disabled={!email.includes("@")}>
            <Plus /> Add person
          </Button>
        </div>

        <div className="space-y-3">
          {users.length === 0 && <p className="text-sm text-muted-foreground">Nobody yet.</p>}
          {users.map((user) => {
            const theirKeys = keys.filter((k) => k.userId === user.id);
            return (
              <div key={user.id} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{user.name ?? user.email}</span>
                  {user.name && <code className="text-xs text-muted-foreground">{user.email}</code>}
                  <select
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                    value={user.teamId}
                    onChange={(e) => moveUser(user.id, e.target.value)}
                    aria-label={`Team for ${user.email}`}
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {user.disabled && <Badge variant="destructive">disabled</Badge>}
                  <div className="ml-auto flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => issueKey(user)}>
                      <KeyRound className="size-4" /> New key
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => removeUser(user.id)} aria-label="Remove person">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {issued?.userId === user.id && (
                  <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
                    <p className="font-medium">Send this to {user.name ?? user.email} — the key is shown once:</p>
                    {/* One line, carrying both this gate's address and their key,
                        so nothing has to be typed twice or in the right order. */}
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                        /gate:login {encodeConnectionToken({ url: origin, key: issued.key })}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            `/gate:login ${encodeConnectionToken({ url: origin, key: issued.key })}`,
                          )
                        }
                        aria-label="Copy command"
                      >
                        <Copy />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      They install the <code>gate</code> plugin in Claude Code and paste that line. It connects this
                      machine and pulls your team&apos;s workflows; after it, <code>/gate:run</code> runs them on their
                      own machine. The raw key is <code>{issued.key}</code> if they need it for a tool that wants one.
                    </p>
                  </div>
                )}

                {theirKeys.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No key yet — they cannot connect.</p>
                ) : (
                  <div className="space-y-1">
                    {theirKeys.map((k) => (
                      <div key={k.id} className="flex items-center gap-3 text-xs text-muted-foreground">
                        <code>{k.prefix}…</code>
                        {k.scopes.includes("author") && <Badge variant="outline">author</Badge>}
                        {k.revoked && <Badge variant="destructive">revoked</Badge>}
                        <span>{k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}</span>
                        {k.lastHost && <span>from {k.lastHost}</span>}
                        {!k.revoked && (
                          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => revoke(k.id)}>
                            Revoke
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
