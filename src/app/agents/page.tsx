"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectBox, SelectionBar, deleteMany, useSelection } from "@/components/bulk-select";

import { newAgentTemplate } from "@/agents/new-agent-template";
import { agentUsage } from "@/workflows/usage";
import type { WorkflowDefinition } from "@/workflows/types";

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
  const [usage, setUsage] = useState<Map<string, string[]>>(new Map());
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selection = useSelection(agents.map((a) => a.id));

  async function load() {
    const r = await fetch("/api/agents");
    const data = await r.json();
    setAgents(data.agents);
    setErrors(data.errors);
    // Which workflows depend on these agents, so deleting one is a warned
    // decision rather than a pipeline that stops parsing later.
    const wr = await fetch("/api/workflows");
    const wd = await wr.json();
    setUsage(agentUsage((wd.workflows ?? []) as Array<Pick<WorkflowDefinition, "id" | "nodes">>));
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

  async function removeSelected() {
    const ids = [...selection.selected];
    if (!ids.length) return;
    const inUse = ids.filter((id) => (usage.get(id) ?? []).length > 0);
    const warning = inUse.length
      ? `\n\n${inUse.map((id) => `${id} is used by ${usage.get(id)!.join(", ")}`).join("\n")}` +
        `\n\nThose workflows stop loading until they are edited.`
      : "";
    const many = ids.length > 1;
    if (!confirm(`Delete ${ids.length} agent${many ? "s" : ""}? The file${many ? "s are" : " is"} removed from ~/.gate/agents.${warning}`)) {
      return;
    }
    setBusy(true);
    const failed = await deleteMany((id) => `/api/agents/${id}`, ids);
    setBusy(false);
    setError(failed.length ? `could not delete ${failed.join(", ")}` : null);
    selection.clear();
    await load();
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
          <SelectionBar selection={selection} total={agents.length} noun="agents" onDelete={removeSelected} busy={busy} />
          {agents.map((a) => {
            const users = usage.get(a.id) ?? [];
            return (
              <Card key={a.id} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
                <SelectBox
                  checked={selection.selected.has(a.id)}
                  onChange={() => selection.toggle(a.id)}
                  label={`Select ${a.id}`}
                />
                <Link href={`/agents/${a.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{a.name}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {a.description ?? <span className="font-mono">{a.id}.md</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {users.length > 0 && (
                      <span className="text-[11px] text-muted-foreground" title={users.join(", ")}>
                        used by {users.length}
                      </span>
                    )}
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
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
