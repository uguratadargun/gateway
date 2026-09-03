"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Plug2, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ClientInfo {
  id: string;
  name: string;
  installed: boolean;
  configPath: string | null;
  configured: boolean;
  canApply: boolean;
  snippet: string;
}

export function ClientsPanel() {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/clients");
    setClients((await r.json()).clients);
  }
  useEffect(() => {
    load();
  }, []);

  async function act(action: "apply" | "revert") {
    setMsg(null);
    const r = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "claude-code", action, apiKey: apiKey || undefined }),
    });
    const d = await r.json();
    setMsg(r.ok ? (d.backup ? `Done — backup at ${d.backup}` : "Done") : d.error ?? "Failed");
    await load();
  }

  function copy(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug2 className="size-4" /> Connect clients
        </CardTitle>
        <CardDescription>Point your tools at gate. Claude Code can be configured in one click.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {clients.map((c) => (
          <div key={c.id} className="rounded-md border">
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <span className="font-medium">{c.name}</span>
              {c.installed ? <Badge variant="secondary">installed</Badge> : <Badge variant="outline">not found</Badge>}
              {c.configured && <Badge variant="success">→ gate</Badge>}
            </button>
            {open === c.id && (
              <div className="space-y-2 border-t bg-muted/20 p-3 text-xs">
                {c.canApply && (
                  <div className="space-y-2">
                    <Input placeholder="Gate API key (optional, only if you issued keys)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 text-xs" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => act("apply")}>
                        <Check /> {c.configured ? "Re-apply" : "Configure Claude Code"}
                      </Button>
                      {c.configured && (
                        <Button size="sm" variant="outline" onClick={() => act("revert")}>
                          <Undo2 /> Revert
                        </Button>
                      )}
                    </div>
                    {msg && <p className="text-muted-foreground">{msg}</p>}
                    <p className="text-muted-foreground">Writes <code>{c.configPath}</code> (backup kept). Restart Claude Code afterwards.</p>
                  </div>
                )}
                <div className="relative">
                  <pre className="overflow-x-auto rounded bg-background p-2 pr-10">{c.snippet}</pre>
                  <Button variant="ghost" size="icon" className="absolute right-1 top-1 h-7 w-7" onClick={() => copy(c.id, c.snippet)} aria-label="Copy">
                    {copied === c.id ? <Check className="text-emerald-500" /> : <Copy />}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
