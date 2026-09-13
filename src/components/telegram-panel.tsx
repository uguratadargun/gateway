"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Send, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * The Telegram bot: its token, and which people's chats it answers for.
 *
 * A link is made for a person and opened by them; it gives their chat a key
 * that may run sessions on this server, so it sits next to the people it is
 * issued to rather than on the Settings page.
 */

interface LinkRow {
  chatId: string;
  username: string | null;
  userId: string | null;
  teamId: string;
  linkedAt: number;
  owner: { email: string; name: string | null } | null;
}

interface Status {
  configured: boolean;
  source: "env" | "dashboard" | null;
  running: boolean;
  username: string | null;
  error: string | null;
  links: LinkRow[];
}

interface Person {
  id: string;
  email: string;
  name: string | null;
  disabled: boolean;
}

interface Issued {
  who: string;
  url: string | null;
  command: string;
  expiresAt: number;
}

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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function TelegramPanel({ users }: { users: Person[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [person, setPerson] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await request("/api/telegram"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // The bot names itself a moment after it starts, and people link from their phones: keep the card current.
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function attempt(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const saveToken = (value: string | null) =>
    attempt(async () => {
      setStatus(await request("/api/telegram", json("PUT", { token: value })));
      setToken("");
      setIssued(null);
      setTimeout(() => void load(), 1_500);
    });

  const createLink = () =>
    attempt(async () => {
      const data = await request("/api/telegram/links", json("POST", { userId: person || null }));
      const user = users.find((u) => u.id === person);
      setIssued({ who: user ? (user.name ?? user.email) : "the default team", url: data.url, command: data.command, expiresAt: data.expiresAt });
    });

  const unlinkChat = (chatId: string) =>
    attempt(async () => {
      await request(`/api/telegram/links/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      await load();
    });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Send className="size-4" /> Telegram
        <span className="ml-auto">
          {!status?.configured ? (
            <Badge variant="outline">not set up</Badge>
          ) : status.error ? (
            <Badge variant="destructive" title={status.error}>
              not connected
            </Badge>
          ) : status.username ? (
            <Badge variant="outline">@{status.username}</Badge>
          ) : (
            <Badge variant="outline">starting…</Badge>
          )}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        A linked person gets the questions, plan approvals and permission prompts of their sessions on this server in their
        Telegram chat, and answers them there; <code>/run</code> in the chat starts a run in one of this gate&apos;s
        repositories. Make a bot with @BotFather, put its token here, then make a link for each person.
      </p>
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">{error}</p>}
      {status?.error && <p className="text-xs text-destructive">{status.error}</p>}

      {status?.source === "env" ? (
        <p className="text-xs text-muted-foreground">
          The token comes from <code>GATE_TELEGRAM_BOT_TOKEN</code>.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-64 flex-1"
            type="password"
            autoComplete="off"
            placeholder={status?.configured ? "Replace the bot token" : "Bot token from @BotFather"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button size="sm" onClick={() => saveToken(token)} disabled={busy || !token.trim()}>
            Save
          </Button>
          {status?.configured && (
            <Button size="sm" variant="ghost" onClick={() => saveToken(null)} disabled={busy}>
              Remove
            </Button>
          )}
        </div>
      )}

      {status?.configured && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              className="h-9 min-w-56 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              aria-label="Who the link is for"
            >
              <option value="">Nobody named — the default team</option>
              {users
                .filter((u) => !u.disabled)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ? `${u.name} (${u.email})` : u.email}
                  </option>
                ))}
            </select>
            <Button size="sm" onClick={createLink} disabled={busy}>
              <Link2 /> Create link
            </Button>
          </div>

          {issued && (
            <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              <p className="font-medium">
                Send this to {issued.who} — it works once, until {new Date(issued.expiresAt).toLocaleTimeString()}:
              </p>
              {[issued.url, issued.command].filter((v): v is string => !!v).map((line) => (
                <div key={line} className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{line}</code>
                  <Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(line)} aria-label="Copy">
                    <Copy />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Opening the link starts the bot with the code; sending the <code>/start</code> line to the bot does the
                same. The chat then holds a key that may run sessions on this server — unlink it here to revoke it.
              </p>
            </div>
          )}

          {status.links.length === 0 ? (
            <p className="text-xs text-muted-foreground">No chat is linked yet.</p>
          ) : (
            <div className="space-y-1">
              {status.links.map((l) => (
                <div key={l.chatId} className="flex items-center gap-3 rounded-md border p-2 text-xs">
                  <span className="font-medium">{l.username ? `@${l.username}` : `chat ${l.chatId}`}</span>
                  <span className="text-muted-foreground">
                    {l.owner ? (l.owner.name ?? l.owner.email) : `${l.teamId} team`} · linked {new Date(l.linkedAt).toLocaleString()}
                  </span>
                  <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => unlinkChat(l.chatId)} disabled={busy}>
                    <Trash2 className="size-3" /> Unlink
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
