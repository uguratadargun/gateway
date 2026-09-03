"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export function KeysPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/keys");
    setKeys((await r.json()).keys);
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await r.json();
    setNewKey(data.plaintext);
    setName("");
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Gateway API keys
        </CardTitle>
        <CardDescription>
          Issue a key per tool. When any key exists, the gateway requires one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input placeholder="Key name (e.g. laptop-cli)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" onClick={create} disabled={!name.trim()}>
            <Plus /> Create
          </Button>
        </div>

        {newKey && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <p className="mb-1 font-medium">Copy this key now — it won&apos;t be shown again:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{newKey}</code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigator.clipboard.writeText(newKey)}
                aria-label="Copy key"
              >
                <Copy />
              </Button>
            </div>
          </div>
        )}

        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No keys — the gateway is open to local requests (or GATE_API_KEY env).
          </p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
                <span className="font-medium">{k.name}</span>
                <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                {k.revoked && <Badge variant="destructive">revoked</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}
                </span>
                <Button variant="ghost" size="icon" onClick={() => remove(k.id)} aria-label="Delete">
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
