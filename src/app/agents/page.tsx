"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { newAgentTemplate } from "@/agents/new-agent-template";

interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  model: string;
  effort?: string;
  inputs: string[];
  output: { type: string };
  updatedAt: number;
}


export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [errors, setErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/agents");
    const data = await r.json();
    setAgents(data.agents);
    setErrors(data.errors);
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    const id = newId.trim();
    if (!id) return;
    const r = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source: newAgentTemplate(id) }),
    });
    if (!r.ok) {
      setError((await r.json()).error ?? "could not create agent");
      return;
    }
    router.push(`/agents/${id}`);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Markdown-defined reasoning workers in ~/.gate/agents. {agents.length} defined.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
          <RefreshCw />
        </Button>
      </header>

      <div className="flex items-center gap-2">
        <Input
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="new-agent-id"
          className="max-w-xs font-mono text-sm"
        />
        <Button onClick={create} disabled={!newId.trim()}>
          <Plus /> New agent
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {errors.length > 0 && (
        <Card className="border-destructive/50 p-4">
          <div className="text-sm font-medium text-destructive">Files that failed to parse</div>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
            {errors.map((e) => (
              <li key={e.id}>
                {e.id}.md — {e.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents yet.</p>
      ) : (
        <div className="space-y-2">
          {agents.map((a) => (
            <Link key={a.id} href={`/agents/${a.id}`}>
              <Card className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {a.description ?? <span className="font-mono">{a.id}.md</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.inputs.length > 0 && (
                    <span className="text-[11px] text-muted-foreground">{a.inputs.length} inputs</span>
                  )}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {a.output.type}
                  </Badge>
                  {a.effort && (
                    <Badge variant="secondary" className="text-[10px]">
                      {a.effort}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {a.model.replace("claude-", "")}
                  </Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
