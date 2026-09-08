"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2, UserPlus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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

export default function TeamPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [teamName, setTeamName] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("default");
  const [issued, setIssued] = useState<{ userId: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [t, u, k] = await Promise.all([
      fetch("/api/teams").then((r) => r.json()),
      fetch("/api/users").then((r) => r.json()),
      fetch("/api/keys").then((r) => r.json()),
    ]);
    setTeams(t.teams ?? []);
    setUsers(u.users ?? []);
    setKeys(k.keys ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body: unknown): Promise<any> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "request failed");
    return data;
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
      const data = await post("/api/keys", { name: `${user.email}`, userId: user.id });
      setIssued({ userId: user.id, key: data.plaintext });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/keys/${id}`, { method: "PATCH" });
    await load();
  }

  async function removeUser(id: string) {
    await fetch(`/api/users/${id}`, { method: "DELETE" });
    await load();
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-sm text-muted-foreground">
          Each person gets a key. They run <code>gate login</code> once, and their team&apos;s workflows run on their own
          machine — through this gateway.
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
                  <Badge variant="outline">{teams.find((t) => t.id === user.teamId)?.name ?? user.teamId}</Badge>
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
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                        gate login --url {origin} --key {issued.key}
                      </code>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => navigator.clipboard.writeText(`gate login --url ${origin} --key ${issued.key}`)}
                        aria-label="Copy command"
                      >
                        <Copy />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      They install the <code>gate</code> plugin in Claude Code, run{" "}
                      <code>node &quot;$CLAUDE_PLUGIN_ROOT/scripts/gate.mjs&quot; install</code> once to get the{" "}
                      <code>gate</code> command, then the line above. After that <code>/gate-run</code> runs your
                      team&apos;s workflows on their machine.
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
